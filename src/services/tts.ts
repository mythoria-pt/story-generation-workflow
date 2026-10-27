/**
 * TTS (Text-to-Speech) Service
 * Handles generating audio narration for stories using configurable TTS providers
 * Generates audio per chapter with intelligent chunking and audio concatenation
 * for texts that exceed provider limits.
 */

import { StoryService } from './story.js';
import { StorageService } from './storage.js';
import { getStorageService } from './storage-singleton.js';
import { ChaptersService } from './chapters.js';
import { tokenUsageTrackingService } from './token-usage-tracking.js';
import { AudioPromptService } from './audio-prompt.js';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';
import { countWords, extractTargetAge } from '@/shared/utils.js';
import {
  getTTSConfig,
  normalizeTTSVoice,
  estimateDuration,
  getAudioFilename,
  buildFirstChapterAudioText,
  buildChapterAudioText,
} from './tts-utils.js';
import { getTTSGateway } from '@/ai/tts-gateway.js';
import { ITTSService, TTSProvider, TTSOptions, TTSResult, TTSUsage } from '@/ai/interfaces.js';
import { splitTextIntoChunks, needsChunking } from './text-chunking.js';
import {
  concatenateAudioBuffers,
  mixAudioWithBackground,
  measureAudioDurationSeconds,
} from './audio-concatenation.js';
import { getBackgroundMusicForStory } from './background-music.js';
import {
  getProviderForVoice,
  getDefaultVoiceForProvider,
  isAutoVoice,
  resolveDefaultVoice,
} from './voice-registry.js';
import { composeStyle, directNarration, shouldDirectNarration } from './narration-direction.js';
import { TTSGenerationError } from './tts-errors.js';

export interface TTSChapterResult {
  chapterNumber: number;
  audioUrl: string;
  duration: number; // in seconds
  format: string;
  provider: TTSProvider;
  voice: string;
  metadata: {
    totalWords: number;
    generatedAt: string;
    model: string;
    speed: number;
  };
}

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/;

/** Return the story language only when it is a BCP-47 locale (e.g. 'pt-PT'). */
export function toLanguageCode(storyLanguage: string | undefined): string | undefined {
  const trimmed = storyLanguage?.trim();
  return trimmed && LANGUAGE_CODE_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Single place that decides the delivery style for one chunk (or one directed segment).
 * Every chunk carries the story's base style; a narration-direction mood, when present,
 * is appended as `${baseStyle}; ${mood}`.
 */
export function resolveChunkStyle(
  baseStyle: string | undefined,
  _chunkIndex: number,
  mood?: string,
): string | undefined {
  return composeStyle(baseStyle, mood);
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * True only when the error explicitly points at the voice (e.g. "voice not found",
 * "invalid voice name") or is a structured 400/404 whose message mentions the voice.
 * A bare 404 / "not found" (wrong model or endpoint) is NOT a voice error.
 */
export function isVoiceError(error: unknown): boolean {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const text = [
    error instanceof Error ? error.message : String(error),
    safeStringify(record.details),
    safeStringify((record.error as { message?: unknown } | undefined)?.message),
  ]
    .join(' ')
    .toLowerCase();

  if (!/voice/.test(text)) {
    return false;
  }

  const status = Number(
    record.status ??
      record.statusCode ??
      record.code ??
      (record.error as { code?: unknown } | undefined)?.code,
  );
  const structuredStatus = status === 400 || status === 404;
  const problem = /not found|not available|invalid|unsupported|unknown|does not exist/.test(text);
  return problem || structuredStatus;
}

export class TTSService {
  private storyService: StoryService;
  private storageService: StorageService;
  private chaptersService: ChaptersService;
  private ttsProvider: ITTSService;

  constructor() {
    this.storyService = new StoryService();
    this.storageService = getStorageService();
    this.chaptersService = new ChaptersService();

    // Initialize TTS provider from gateway
    this.ttsProvider = getTTSGateway().getTTSService();
  }

  /**
   * Generate audio narration for a chapter from text content
   */
  async generateChapterAudioFromText(
    storyId: string,
    chapterNumber: number,
    chapterContent: string,
    storyTitle: string,
    voice?: string,
    _sectionType: 'dedicatory' | 'chapter' | 'credits' = 'chapter',
    extraParams?: {
      storyAuthor?: string;
      dedicatoryMessage?: string;
      storyLanguage?: string;
      isFirstChapter?: boolean;
      includeBackgroundMusic?: boolean;
      chapterTitle?: string;
    },
  ): Promise<TTSChapterResult> {
    try {
      logger.info('Starting TTS generation for chapter', {
        storyId,
        chapterNumber,
        voice,
        isFirstChapter: extraParams?.isFirstChapter || false,
      });

      // Get story details to check language
      const story = await this.storyService.getStory(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }

      // Get TTS configuration
      const config = getTTSConfig();
      // Empty / missing / 'auto' voice: SGW picks the recommended voice for the story audience
      const requestedVoice = isAutoVoice(voice) ? undefined : voice?.trim();
      const audienceVoice = story.targetAudience
        ? resolveDefaultVoice(config.provider, story.targetAudience)
        : undefined;
      if (requestedVoice) {
        config.voice = requestedVoice;
      } else if (audienceVoice) {
        config.voice = audienceVoice;
        logger.info('Resolved default TTS voice from story audience', {
          storyId,
          chapterNumber,
          targetAudience: story.targetAudience,
          voice: config.voice,
        });
      }
      const normalizedVoice = normalizeTTSVoice(config.provider, config.voice, audienceVoice);
      if (normalizedVoice.wasFallback) {
        logger.warn('Ignoring unsupported TTS voice for provider', {
          storyId,
          chapterNumber,
          provider: config.provider,
          requestedVoice: config.voice,
          fallbackVoice: normalizedVoice.voice,
        });
      }
      config.voice = normalizedVoice.voice;

      // Use story language from parameters or story record
      const storyLanguage = extraParams?.storyLanguage || story.storyLanguage || 'en-US';
      const providedAuthor =
        typeof extraParams?.storyAuthor === 'string' ? extraParams.storyAuthor.trim() : '';
      const customAuthor = typeof story.customAuthor === 'string' ? story.customAuthor.trim() : '';
      const storyAuthor = providedAuthor || customAuthor || story.author || 'Unknown Author';
      const dedicatoryMessage = extraParams?.dedicatoryMessage || story.dedicationMessage;
      const chapterTitle =
        typeof extraParams?.chapterTitle === 'string' ? extraParams.chapterTitle.trim() : '';

      // Extract target age from story.targetAudience
      const targetAge = extractTargetAge(story.targetAudience);

      // Delivery style (Gemini) keyed by target age; unknown ages use 'general audience'
      const baseStyle = await AudioPromptService.getBaseStyle(storyLanguage, targetAge);
      const languageCode = toLanguageCode(storyLanguage);

      // Generate audio for the chapter using the TTS provider
      // Uses intelligent chunking and concatenation for long texts
      const ttsOptions: TTSOptions = {
        voice: config.voice,
        speed: config.speed,
        model: config.model,
        language: storyLanguage,
        chapterNumber,
        ...(languageCode ? { languageCode } : {}),
      };

      // Smart Provider Detection:
      // If a voice is specified, check if it belongs to the current provider.
      // If not, try to switch to the correct provider.
      let effectiveProvider: TTSProvider = config.provider;
      let effectiveTTSProvider: ITTSService = this.ttsProvider;

      if (requestedVoice) {
        const detectedProvider = getProviderForVoice(requestedVoice);
        if (detectedProvider && detectedProvider !== config.provider) {
          logger.info('Switching TTS provider based on requested voice', {
            requestedVoice,
            configuredProvider: config.provider,
            detectedProvider,
          });
          try {
            effectiveTTSProvider = getTTSGateway().getService(detectedProvider);
            effectiveProvider = detectedProvider;
            // The requested voice belongs to the switched-to provider
            ttsOptions.voice = requestedVoice;
            // When switching providers, we should clear the model to let the new service use its default
            delete ttsOptions.model;
          } catch (switchError) {
            logger.warn('Failed to switch TTS provider, falling back to default provider', {
              error: switchError instanceof Error ? switchError.message : String(switchError),
              requestedVoice,
              defaultProvider: config.provider,
            });
          }
        }
      }

      // OpenAI-only instruction string (accent + style); Gemini gets style + languageCode instead
      if (effectiveProvider === 'openai') {
        ttsOptions.systemPrompt = await AudioPromptService.getTTSSystemPrompt(
          storyLanguage,
          targetAge,
        );
      }

      // Prepare chapter text for TTS (pauses come from paragraph breaks, never from tags)
      let chapterText: string;
      if (extraParams?.isFirstChapter) {
        // For first chapter, include story title, dedication, author intro, and chapter content
        chapterText = await buildFirstChapterAudioText(
          storyTitle,
          dedicatoryMessage,
          storyAuthor,
          storyLanguage,
          chapterContent,
          chapterTitle,
          effectiveProvider,
        );
      } else {
        // For other chapters, use translated "Chapter X" + content
        chapterText = await buildChapterAudioText(
          chapterNumber,
          storyLanguage,
          chapterContent,
          chapterTitle,
          effectiveProvider,
        );
      }

      const maxTextLength = effectiveTTSProvider.getMaxTextLength();
      const usageTotals: TTSUsage = { inputTokens: 0, outputTokens: 0 };
      let usageReported = false;
      // Per chunk: provider usage when reported, else characters as an input proxy (0 output)
      const addUsage = (result: TTSResult, chunkText: string): void => {
        if (result.usage) {
          usageReported = true;
          usageTotals.inputTokens += result.usage.inputTokens;
          usageTotals.outputTokens += result.usage.outputTokens;
        } else {
          usageTotals.inputTokens += chunkText.length;
        }
      };
      let audioBuffer: Buffer;
      let actualVoice: string = config.voice;
      let actualModel: string = config.model;
      let actualProvider: TTSProvider = effectiveProvider;

      // Helper function for synthesis with fallback
      const synthesizeWithFallback = async (
        text: string,
        options: TTSOptions,
      ): Promise<TTSResult> => {
        try {
          return await effectiveTTSProvider.synthesize(text, options);
        } catch (synthError) {
          const errorMsg = synthError instanceof Error ? synthError.message : String(synthError);

          if (isVoiceError(synthError)) {
            const audienceVoice = resolveDefaultVoice(effectiveProvider, story.targetAudience);
            const fallbackVoice =
              audienceVoice !== options.voice
                ? audienceVoice
                : getDefaultVoiceForProvider(effectiveProvider);
            logger.warn('TTS synthesis failed for requested voice, falling back to default voice', {
              requestedVoice: options.voice,
              fallbackVoice,
              provider: effectiveProvider,
              error: errorMsg,
            });

            // Retry with fallback voice
            return await effectiveTTSProvider.synthesize(text, {
              ...options,
              voice: fallbackVoice,
            });
          }
          // If not a voice error, rethrow
          throw synthError;
        }
      };

      // Optional per-chunk narration direction (Gemini only, behind a flag). Any failure
      // falls back to the base style for that chunk; narration is never blocked.
      const directionEnabled = shouldDirectNarration(effectiveProvider);
      const directionStats = { directedChunks: 0, fallbackChunks: 0 };
      const synthesizeChunk = async (text: string, chunkIndex: number): Promise<TTSResult> => {
        if (directionEnabled) {
          const direction = await directNarration({
            text,
            storyLanguage,
            targetAge,
            authorId: story.authorId,
            storyId,
            chapterNumber,
            chunkIndex,
          });
          if (direction.source === 'llm') {
            directionStats.directedChunks += 1;
            return synthesizeWithFallback(text, {
              ...ttsOptions,
              segments: direction.segments.map((segment) => {
                const segmentStyle = resolveChunkStyle(baseStyle, chunkIndex, segment.mood);
                return { text: segment.text, ...(segmentStyle ? { style: segmentStyle } : {}) };
              }),
            });
          }
          directionStats.fallbackChunks += 1;
        }
        const chunkStyle = resolveChunkStyle(baseStyle, chunkIndex);
        return synthesizeWithFallback(text, {
          ...ttsOptions,
          ...(chunkStyle ? { style: chunkStyle } : {}),
        });
      };

      if (needsChunking(chapterText, maxTextLength)) {
        // Text exceeds provider limit - use chunking and concatenation
        logger.info('Text exceeds provider limit, using chunking', {
          storyId,
          chapterNumber,
          textLength: chapterText.length,
          maxTextLength,
          provider: config.provider,
        });

        const chunks = splitTextIntoChunks(chapterText, maxTextLength, {
          preferParagraphs: true,
          minChunkSize: 500,
          preserveDialogue: true,
        });

        logger.info('Text split into chunks', {
          storyId,
          chapterNumber,
          chunkCount: chunks.length,
          chunkSizes: chunks.map((c) => c.text.length),
        });

        // Generate audio for each chunk sequentially
        const audioBuffers: Buffer[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk) {
            throw new Error(`Chunk at index ${i} is undefined`);
          }
          logger.info('Generating audio for chunk', {
            storyId,
            chapterNumber,
            chunkIndex: i + 1,
            chunkCount: chunks.length,
            chunkLength: chunk.text.length,
          });

          const chunkResult = await synthesizeChunk(chunk.text, i);
          audioBuffers.push(chunkResult.buffer);
          addUsage(chunkResult, chunk.text);

          // Store first chunk's metadata as the canonical values
          if (i === 0) {
            actualVoice = chunkResult.voice;
            actualModel = chunkResult.model;
            actualProvider = chunkResult.provider;
          }
        }

        // Concatenate all audio chunks into single MP3
        logger.info('Concatenating audio chunks', {
          storyId,
          chapterNumber,
          chunkCount: audioBuffers.length,
        });

        const concatenationResult = await concatenateAudioBuffers(audioBuffers);
        audioBuffer = concatenationResult.buffer;

        logger.info('Audio concatenation complete', {
          storyId,
          chapterNumber,
          finalSize: audioBuffer.length,
          chunkCount: concatenationResult.chunkCount,
        });
      } else {
        // Text within limit - single synthesis call
        const ttsResult = await synthesizeChunk(chapterText, 0);
        addUsage(ttsResult, chapterText);
        audioBuffer = ttsResult.buffer;
        actualVoice = ttsResult.voice;
        actualModel = ttsResult.model;
        actualProvider = ttsResult.provider;
      }

      // Mix with background music if enabled
      const env = getEnvironment();
      const shouldMixBackground =
        env.BACKGROUND_MUSIC_ENABLED && (extraParams?.includeBackgroundMusic ?? true);

      if (shouldMixBackground) {
        const backgroundMusic = getBackgroundMusicForStory(story.targetAudience, story.novelStyle);

        if (backgroundMusic) {
          logger.info('Mixing narration with background music', {
            storyId,
            chapterNumber,
            musicCode: backgroundMusic.musicCode,
            narrationVolume: env.NARRATOR_VOLUME,
            backgroundVolume: env.BACKGROUND_MUSIC_VOLUME,
          });

          const mixResult = await mixAudioWithBackground(audioBuffer, backgroundMusic.filePath, {
            narrationVolume: env.NARRATOR_VOLUME,
            backgroundVolume: env.BACKGROUND_MUSIC_VOLUME,
            fadeInDuration: env.BACKGROUND_MUSIC_FADE_IN,
            fadeOutDuration: env.BACKGROUND_MUSIC_FADE_OUT,
          });

          if (mixResult.hasMixedBackground) {
            audioBuffer = mixResult.buffer;
            logger.info('Background music mixed successfully', {
              storyId,
              chapterNumber,
              musicCode: backgroundMusic.musicCode,
              originalSize: audioBuffer.length,
              mixedSize: mixResult.buffer.length,
            });
          }
        } else {
          logger.error('Background music requested but file is not available', {
            storyId,
            chapterNumber,
            targetAudience: story.targetAudience,
            novelStyle: story.novelStyle,
          });
          throw new TTSGenerationError('Requested background music is unavailable', {
            code: 'BACKGROUND_MUSIC_UNAVAILABLE',
            statusCode: 424,
            retryable: false,
          });
        }
      } else {
        logger.debug('Background music disabled for this chapter', {
          storyId,
          chapterNumber,
          globalEnabled: env.BACKGROUND_MUSIC_ENABLED,
          requestEnabled: extraParams?.includeBackgroundMusic,
        });
      }

      // Measure the real duration of the final MP3; fall back to the word-count estimate
      const measuredDuration = await measureAudioDurationSeconds(audioBuffer);
      const duration = measuredDuration ?? estimateDuration(chapterText);

      // Record token usage for TTS generation
      try {
        await tokenUsageTrackingService.recordUsage({
          authorId: story.authorId,
          storyId: storyId,
          action: 'audio_generation',
          aiModel: actualModel,
          inputTokens: usageTotals.inputTokens,
          outputTokens: usageTotals.outputTokens,
          inputPromptJson: {
            chapterNumber,
            chapterText: chapterText.substring(0, 500) + '...', // Store first 500 chars for reference
            voice: actualVoice,
            speed: config.speed,
            provider: actualProvider,
            model: actualModel,
            storyLanguage: storyLanguage,
            baseStyle,
            languageCode: languageCode ?? null,
            usageReported,
            narrationDirection: {
              enabled: directionEnabled,
              ...directionStats,
            },
            targetAge,
            isFirstChapter: extraParams?.isFirstChapter || false,
          },
        });

        logger.info('TTS token usage recorded', {
          storyId,
          chapterNumber,
          characters: chapterText.length,
          inputTokens: usageTotals.inputTokens,
          outputTokens: usageTotals.outputTokens,
          model: actualModel,
          authorId: story.authorId,
          storyLanguage,
        });
      } catch (error) {
        logger.error('Failed to record TTS token usage', {
          error: error instanceof Error ? error.message : String(error),
          storyId,
          chapterNumber,
        });
        // Don't throw - we don't want to break TTS generation due to tracking failures
      }

      // Upload chapter audio to storage with chapter filename
      const audioFilename = getAudioFilename(storyId, chapterNumber);
      const audioUrl = await this.storageService.uploadFile(
        audioFilename,
        audioBuffer,
        'audio/mpeg',
      );

      // Update chapter audio URI in database
      await this.chaptersService.updateChapterAudio(storyId, chapterNumber, audioUrl);

      const result: TTSChapterResult = {
        chapterNumber,
        audioUrl,
        duration,
        format: 'mp3',
        provider: actualProvider,
        voice: actualVoice,
        metadata: {
          totalWords: countWords(chapterText),
          generatedAt: new Date().toISOString(),
          model: actualModel,
          speed: config.speed,
        },
      };

      logger.info('TTS generation completed for chapter', {
        storyId,
        chapterNumber,
        provider: actualProvider,
        audioUrl,
        duration: result.duration,
        wordCount: result.metadata.totalWords,
        storyLanguage,
      });

      return result;
    } catch (error) {
      logger.error('TTS generation failed for chapter', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber,
      });
      throw error;
    }
  }
}
