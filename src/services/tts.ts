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
  estimateDuration,
  getAudioFilename,
  buildFirstChapterAudioText,
  buildChapterAudioText,
} from './tts-utils.js';
import { getTTSGateway } from '@/ai/tts-gateway.js';
import { ITTSService, TTSProvider, TTSOptions } from '@/ai/interfaces.js';
import { splitTextIntoChunks, needsChunking } from './text-chunking.js';
import { concatenateAudioBuffers, mixAudioWithBackground } from './audio-concatenation.js';
import { getBackgroundMusicForStory } from './background-music.js';

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
      if (voice) {
        config.voice = voice;
      }

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

      // Load audio prompt configuration for the story language
      const audioPromptConfig = await AudioPromptService.getTTSInstructions(
        storyLanguage,
        targetAge,
      );

      // Prepare chapter text for TTS
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
        );
      } else {
        // For other chapters, use translated "Chapter X" + content
        chapterText = await buildChapterAudioText(
          chapterNumber,
          storyLanguage,
          chapterContent,
          chapterTitle,
        );
      }

      // Enhance text with audio prompts if available
      if (audioPromptConfig) {
        logger.info('Applying audio prompt configuration', {
          storyId,
          chapterNumber,
          language: audioPromptConfig.language,
          languageName: audioPromptConfig.languageName,
          targetAge,
        });

        chapterText = AudioPromptService.enhanceTextForTTS(
          chapterText,
          audioPromptConfig.systemPrompt,
          audioPromptConfig.instructions,
        );
      } else {
        logger.warn('No audio prompt configuration found, using basic TTS', {
          storyId,
          chapterNumber,
          storyLanguage,
          targetAge,
          targetAudience: story.targetAudience,
        });
      }

      // Get TTS system prompt for accent enforcement
      // This is sent as a system instruction to the TTS API on every request
      const ttsSystemPrompt = await AudioPromptService.getTTSSystemPrompt(storyLanguage, targetAge);

      logger.info('TTS system prompt loaded for accent enforcement', {
        storyId,
        chapterNumber,
        storyLanguage,
        promptLength: ttsSystemPrompt.length,
      });

      // Generate audio for the chapter using the TTS provider
      // Uses intelligent chunking and concatenation for long texts
      const ttsOptions: TTSOptions = {
        voice: config.voice,
        speed: config.speed,
        model: config.model,
        language: storyLanguage,
        systemPrompt: ttsSystemPrompt,
        chapterNumber,
      };

      const maxTextLength = this.ttsProvider.getMaxTextLength();
      let audioBuffer: Buffer;
      let actualVoice: string = config.voice;
      let actualModel: string = config.model;
      let actualProvider: TTSProvider = config.provider;

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

          const chunkResult = await this.ttsProvider.synthesize(chunk.text, ttsOptions);
          audioBuffers.push(chunkResult.buffer);

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
        const ttsResult = await this.ttsProvider.synthesize(chapterText, ttsOptions);
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
            backgroundVolume: env.BACKGROUND_MUSIC_VOLUME,
          });

          const mixResult = await mixAudioWithBackground(audioBuffer, backgroundMusic.filePath, {
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
          logger.info('Skipping background music - file not available', {
            storyId,
            chapterNumber,
            targetAudience: story.targetAudience,
            novelStyle: story.novelStyle,
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

      // Record token usage for TTS generation
      try {
        await tokenUsageTrackingService.recordUsage({
          authorId: story.authorId,
          storyId: storyId,
          action: 'audio_generation',
          aiModel: actualModel,
          inputTokens: chapterText.length, // Characters in the input text
          outputTokens: 0, // TTS doesn't have traditional output tokens
          inputPromptJson: {
            chapterNumber,
            chapterText: chapterText.substring(0, 500) + '...', // Store first 500 chars for reference
            voice: actualVoice,
            speed: config.speed,
            provider: actualProvider,
            model: actualModel,
            storyLanguage: storyLanguage,
            audioPromptConfig: audioPromptConfig
              ? {
                  language: audioPromptConfig.language,
                  languageName: audioPromptConfig.languageName,
                  systemPrompt: audioPromptConfig.systemPrompt.substring(0, 300) + '...', // First 300 chars of system prompt
                  instructions: audioPromptConfig.instructions,
                }
              : null,
            targetAge,
            isFirstChapter: extraParams?.isFirstChapter || false,
          },
        });

        logger.info('TTS token usage recorded', {
          storyId,
          chapterNumber,
          characters: chapterText.length,
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
        duration: estimateDuration(chapterText),
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
