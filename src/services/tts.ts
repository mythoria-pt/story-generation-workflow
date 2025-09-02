/**
 * TTS (Text-to-Speech) Service
 * Handles generating audio narration for stories using OpenAI
 * Generates audio per chapter to avoid character limits and provide better UX
 */

import { StoryService } from './story.js';
import { StorageService } from './storage.js';
import { getStorageService } from './storage-singleton.js';
import { ChaptersService } from './chapters.js';
import { tokenUsageTrackingService } from './token-usage-tracking.js';
import { AudioPromptService } from './audio-prompt.js';
import { logger } from '@/config/logger.js';
import OpenAI from 'openai';
import { countWords, extractTargetAge } from '@/shared/utils.js';
import { 
  TTSConfig, 
  getTTSConfig, 
  estimateDuration, 
  truncateTextForTTS, 
  getAudioFilename,
  buildFirstChapterAudioText,
  buildChapterAudioText
} from './tts-utils.js';

export interface TTSChapterResult {
  chapterNumber: number;
  audioUrl: string;
  duration: number; // in seconds
  format: string;
  provider: 'openai';
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
  private openaiClient: OpenAI | null = null;

  constructor() {
    this.storyService = new StoryService();
  this.storageService = getStorageService();
    this.chaptersService = new ChaptersService();
    
    // Initialize OpenAI client if API key is available
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (openaiApiKey) {
      this.openaiClient = new OpenAI({
        apiKey: openaiApiKey,
      });
    }
  }

  /**
   * Synthesize speech using OpenAI TTS
   */
  private async synthesizeSpeechOpenAI(
    text: string, 
    config: TTSConfig
  ): Promise<{ buffer: Buffer; voice: string; model: string }> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized. Check OPENAI_API_KEY environment variable.');
    }

    try {
      logger.info('Generating TTS with OpenAI', {
        model: config.model,
        voice: config.voice,
        speed: config.speed,
        textLength: text.length
      });
      
      const response = await this.openaiClient.audio.speech.create({
        model: config.model as 'gpt-4o-mini-tts' | 'gpt-4o-mini-tts-hd',
        voice: config.voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
        input: text,
        speed: config.speed,
        response_format: 'mp3'
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      
      return {
        buffer,
        voice: config.voice,
        model: config.model
      };
    } catch (error) {
      logger.error('OpenAI TTS synthesis failed', {
        error: error instanceof Error ? error.message : String(error),
        model: config.model,
        voice: config.voice
      });
      throw error;
    }
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
    }
  ): Promise<TTSChapterResult> {
    try {
      logger.info('Starting TTS generation for chapter', {
        storyId,
        chapterNumber,
        voice,
        isFirstChapter: extraParams?.isFirstChapter || false
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
      const storyAuthor = extraParams?.storyAuthor || story.author || 'Unknown Author';
      const dedicatoryMessage = extraParams?.dedicatoryMessage || story.dedicationMessage;
      
      // Extract target age from story.targetAudience
      const targetAge = extractTargetAge(story.targetAudience);
      
      // Load audio prompt configuration for the story language
      const audioPromptConfig = await AudioPromptService.getTTSInstructions(
        storyLanguage,
        targetAge
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
          chapterContent
        );
      } else {
        // For other chapters, use translated "Chapter X" + content
        chapterText = await buildChapterAudioText(
          chapterNumber,
          storyLanguage,
          chapterContent
        );
      }

      // Ensure text is within TTS limits
      chapterText = truncateTextForTTS(chapterText);

      // Enhance text with audio prompts if available
      if (audioPromptConfig) {
        logger.info('Applying audio prompt configuration', {
          storyId,
          chapterNumber,
          language: audioPromptConfig.language,
          languageName: audioPromptConfig.languageName,
          targetAge
        });

        chapterText = AudioPromptService.enhanceTextForTTS(
          chapterText,
          audioPromptConfig.systemPrompt,
          audioPromptConfig.instructions
        );
      } else {
        logger.warn('No audio prompt configuration found, using basic TTS', {
          storyId,
          chapterNumber,
          storyLanguage,
          targetAge,
          targetAudience: story.targetAudience
        });
      }

      // Generate audio for the chapter
      let audioBuffer: Buffer;
      let actualVoice: string;
      let actualModel: string;

      if (config.provider === 'openai') {
        const result = await this.synthesizeSpeechOpenAI(chapterText, config);
        audioBuffer = result.buffer;
        actualVoice = result.voice;
        actualModel = result.model;
      } else {
        throw new Error(`TTS provider '${config.provider}' is not supported. Only 'openai' is currently supported.`);
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
            provider: config.provider,
            model: actualModel,
            storyLanguage: storyLanguage,
            audioPromptConfig: audioPromptConfig ? {
              language: audioPromptConfig.language,
              languageName: audioPromptConfig.languageName,
              systemPrompt: audioPromptConfig.systemPrompt.substring(0, 300) + '...', // First 300 chars of system prompt
              instructions: audioPromptConfig.instructions
            } : null,
            targetAge,
            isFirstChapter: extraParams?.isFirstChapter || false
          }
        });

        logger.info('TTS token usage recorded', {
          storyId,
          chapterNumber,
          characters: chapterText.length,
          model: actualModel,
          authorId: story.authorId,
          storyLanguage
        });
      } catch (error) {
        logger.error('Failed to record TTS token usage', {
          error: error instanceof Error ? error.message : String(error),
          storyId,
          chapterNumber
        });
        // Don't throw - we don't want to break TTS generation due to tracking failures
      }

      // Upload chapter audio to storage with chapter filename
      const audioFilename = getAudioFilename(storyId, chapterNumber);
      const audioUrl = await this.storageService.uploadFile(
        audioFilename,
        audioBuffer,
        'audio/mpeg'
      );

      // Update chapter audio URI in database
      await this.chaptersService.updateChapterAudio(storyId, chapterNumber, audioUrl);

      const result: TTSChapterResult = {
        chapterNumber,
        audioUrl,
        duration: estimateDuration(chapterText),
        format: 'mp3',
        provider: config.provider,
        voice: actualVoice,
        metadata: {
          totalWords: countWords(chapterText),
          generatedAt: new Date().toISOString(),
          model: actualModel,
          speed: config.speed
        }
      };

      logger.info('TTS generation completed for chapter', {
        storyId,
        chapterNumber,
        provider: config.provider,
        audioUrl,
        duration: result.duration,
        wordCount: result.metadata.totalWords,
        storyLanguage
      });

      return result;
    } catch (error) {
      logger.error('TTS generation failed for chapter', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber
      });
      throw error;
    }
  }
}