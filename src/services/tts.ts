/**
 * TTS (Text-to-Speech) Service
 * Handles generating audio narration for stories using OpenAI and Google Vertex AI
 * Generates audio per chapter to avoid character limits and provide better UX
 */

import { RunsService } from './runs.js';
import { StoryService } from './story.js';
import { StorageService } from './storage.js';
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
  provider: 'openai' | 'vertex';
  voice: string;
  metadata: {
    totalWords: number;
    generatedAt: string;
    model: string;
    speed: number;
  };
}

export interface TTSResult {
  audioUrls: Record<number, string>; // chapter number -> audio URL
  totalDuration: number; // in seconds
  format: string;
  provider: 'openai' | 'vertex';
  voice: string;
  metadata: {
    totalWords: number;
    generatedAt: string;
    model: string;
    speed: number;
    chaptersProcessed: number;
  };
}

export class TTSService {
  private runsService: RunsService;
  private storyService: StoryService;
  private storageService: StorageService;
  private openaiClient: OpenAI | null = null;

  constructor() {
    this.runsService = new RunsService();
    this.storyService = new StoryService();
    this.storageService = new StorageService();
    
    // Initialize OpenAI client if API key is available
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (openaiApiKey) {
      this.openaiClient = new OpenAI({
        apiKey: openaiApiKey,
      });
    }
  }

  /**
   * Generate audio narration for a single chapter
   */
  async generateChapterNarration(runId: string, chapterNumber: number): Promise<TTSChapterResult> {
    try {
      logger.info('Starting TTS generation for chapter', { runId, chapterNumber });

      // Get run details
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }      // Get story details to obtain the story language
      const story = await this.storyService.getStory(run.storyId);
      if (!story) {
        throw new Error(`Story not found: ${run.storyId}`);
      }

      logger.info('Starting audio generation for chapter', { 
        runId, 
        chapterNumber,
        storyId: run.storyId
      });

      // Get TTS configuration
      const config = getTTSConfig();

      // Get the specific chapter
      const chapterStep = await this.runsService.getStepResult(runId, `write_chapter_${chapterNumber}`);
      if (!chapterStep?.detailJson) {
        throw new Error(`Chapter ${chapterNumber} not found`);
      }

      const chapterData = chapterStep.detailJson as Record<string, unknown>;
      const chapterContent = chapterData.chapter as string || '';      // Use story language from the story record
      const storyLanguage = story.storyLanguage || 'en-US';
      
      // Extract target age from story.targetAudience
      const targetAge = extractTargetAge(story.targetAudience);
      
      // Load audio prompt configuration for the story language
      const audioPromptConfig = await AudioPromptService.getTTSInstructions(
        storyLanguage,
        targetAge // Pass the extracted target age
      );

      // Prepare chapter text for TTS with enhanced first chapter logic
      let chapterText: string;
      if (chapterNumber === 1) {
        // For first chapter, include story title, dedication, author intro, and translated chapter
        chapterText = await buildFirstChapterAudioText(
          story.title || 'Untitled Story',
          story.dedicationMessage,
          story.author || 'Unknown Author',
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
      chapterText = truncateTextForTTS(chapterText);      // Enhance text with audio prompts if available
      if (audioPromptConfig) {
        logger.info('Applying audio prompt configuration', {
          runId,
          chapterNumber,
          language: audioPromptConfig.language,
          languageName: audioPromptConfig.languageName,
          targetAge
        });

        // Use audio prompts to enhance text processing and get voice recommendations
        chapterText = AudioPromptService.enhanceTextForTTS(
          chapterText,
          audioPromptConfig.systemPrompt,
          audioPromptConfig.instructions
        );

        // Get recommended voice and speed based on audio prompts
        const recommendedVoice = AudioPromptService.getRecommendedVoice(
          audioPromptConfig.systemPrompt,
          storyLanguage,
          targetAge // Pass the extracted target age
        );
        
        const recommendedSpeed = AudioPromptService.getRecommendedSpeed(
          targetAge, // Pass the extracted target age
          audioPromptConfig.instructions
        );

        // Override config with recommendations from audio prompts
        config.voice = recommendedVoice;
        config.speed = recommendedSpeed;

        logger.info('Applied audio prompt recommendations', {
          runId,
          chapterNumber,
          recommendedVoice,
          recommendedSpeed,
          originalVoice: process.env.TTS_VOICE,
          originalSpeed: process.env.TTS_SPEED,
          targetAge,
          targetAudience: story.targetAudience
        });
      } else {
        logger.warn('No audio prompt configuration found, using basic TTS', {
          runId,
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
        const result = await this.synthesizeSpeechVertex(chapterText, config, storyLanguage);        audioBuffer = result.buffer;
        actualVoice = result.voice;
        actualModel = result.model;
      }

      // Record token usage for TTS generation
      try {
        await tokenUsageTrackingService.recordUsage({
          authorId: story.authorId,
          storyId: run.storyId,
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
            storyLanguage: story.storyLanguage || 'en-US'
          }
        });

        logger.info('TTS token usage recorded', {
          runId,
          chapterNumber,
          characters: chapterText.length,
          model: actualModel,
          authorId: story.authorId
        });
      } catch (error) {
        logger.error('Failed to record TTS token usage', {
          error: error instanceof Error ? error.message : String(error),
          runId,
          chapterNumber
        });
        // Don't throw - we don't want to break TTS generation due to tracking failures
      }

      // Upload chapter audio to storage with zero-padded filename
      const audioFilename = getAudioFilename(run.storyId, chapterNumber);
      const audioUrl = await this.storageService.uploadFile(
        audioFilename,
        audioBuffer,
        'audio/mpeg'
      );

      // Update story audiobookUri with this chapter's audio
      await this.updateStoryAudiobookUri(run.storyId, chapterNumber, audioUrl);

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
        runId,
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
        runId,
        chapterNumber
      });
      throw error;
    }
  }

  /**
   * Generate audio narration for all chapters sequentially
   */
  async generateNarration(runId: string): Promise<TTSResult> {
    try {
      logger.info('Starting TTS generation for all chapters', { runId });

      // Get run details
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      // Get story details to check features
      const story = await this.storyService.getStory(run.storyId);
      if (!story) {
        throw new Error(`Story not found: ${run.storyId}`);
      }      
      // Check if story has audioBook feature enabled
      const features = (story.features as Record<string, unknown>) || {};
      if (!features.audioBook) {
        logger.info('Audio generation skipped - not enabled for this story', { 
          runId, 
          storyId: run.storyId, 
          audioBookEnabled: features.audioBook 
        });
        
        // Return empty result indicating audio generation was skipped
        return {
          audioUrls: {},
          totalDuration: 0,
          format: 'mp3',
          provider: 'openai' as const,
          voice: 'coral',
          metadata: {
            totalWords: 0,
            generatedAt: new Date().toISOString(),
            model: 'gpt-4.1',
            speed: 0.9,
            chaptersProcessed: 0
          }
        };
      }

      logger.info('Audio generation authorized for story', { 
        runId, 
        storyId: run.storyId, 
        audioBookEnabled: features.audioBook 
      });

      // Get all chapters
      const steps = await this.runsService.getRunSteps(runId);
      const chapterSteps = steps.filter(step => step.stepName.startsWith('write_chapter_'));

      // Sort chapters by number
      const chapters = chapterSteps
        .map(step => ({
          number: parseInt(step.stepName.replace('write_chapter_', '')),
          content: (step.detailJson as Record<string, unknown>)?.chapter as string || ''
        }))
        .sort((a, b) => a.number - b.number);

      if (chapters.length === 0) {
        throw new Error('No chapters found for TTS generation');
      }

      const config = getTTSConfig();
      const audioUrls: Record<number, string> = {};
      let totalDuration = 0;
      let totalWords = 0;

      // Process each chapter sequentially
      for (const chapter of chapters) {
        logger.info(`Processing chapter ${chapter.number}/${chapters.length}`, { runId });
        
        const chapterResult = await this.generateChapterNarration(runId, chapter.number);
        
        audioUrls[chapter.number] = chapterResult.audioUrl;
        totalDuration += chapterResult.duration;
        totalWords += chapterResult.metadata.totalWords;
      }

      const result: TTSResult = {
        audioUrls,
        totalDuration,
        format: 'mp3',
        provider: config.provider,
        voice: config.voice,
        metadata: {
          totalWords,
          generatedAt: new Date().toISOString(),
          model: config.model,
          speed: config.speed,
          chaptersProcessed: chapters.length
        }
      };

      logger.info('TTS generation completed for all chapters', {
        runId,
        chaptersProcessed: chapters.length,
        totalDuration,
        totalWords,
        provider: config.provider
      });

      return result;
    } catch (error) {
      logger.error('TTS generation failed', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }

  /**
   * Update story's audiobookUri with chapter audio URL
   */
  private async updateStoryAudiobookUri(storyId: string, chapterNumber: number, audioUrl: string): Promise<void> {
    try {
      // Get current story
      const story = await this.storyService.getStory(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }      // Get current audiobookUri or create new one
      let audiobookUri = (story.audiobookUri as Record<string, string>) || {};
      if (typeof audiobookUri !== 'object') {
        audiobookUri = {};
      }

      // Add/update the chapter audio URL
      audiobookUri[`chapter_${chapterNumber}`] = audioUrl;

      // Update the story
      await this.storyService.updateStoryUris(storyId, {
        audiobookUri
      });

      logger.info('Updated story audiobookUri', {
        storyId,
        chapterNumber,
        audioUrl
      });
    } catch (error) {
      logger.error('Failed to update story audiobookUri', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber,
        audioUrl
      });
      throw error;
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
        model: config.model as 'tts-1' | 'tts-1-hd',
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
   * Synthesize speech using Google Vertex AI (placeholder for future implementation)
   */
  private async synthesizeSpeechVertex(
    text: string, 
    config: TTSConfig, 
    language: string
  ): Promise<{ buffer: Buffer; voice: string; model: string }> {
    // This is a placeholder for Google Cloud Text-to-Speech implementation
    // In production, you would use Google Cloud TTS API
    
    logger.warn('Vertex AI TTS not yet implemented, falling back to OpenAI', {
      textLength: text.length,
      language,
      requestedVoice: config.voice
    });
    
    // Fallback to OpenAI if available
    if (this.openaiClient) {
      return this.synthesizeSpeechOpenAI(text, config);
    }
    
    // Ultimate fallback - placeholder implementation
    logger.warn('TTS synthesis using placeholder implementation', {
      textLength: text.length
    });
    
    // For now, return a minimal audio buffer placeholder
    const placeholderAudio = Buffer.from('placeholder-audio-data');
    
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return {
      buffer: placeholderAudio,
      voice: 'placeholder',
      model: 'placeholder'
    };
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
        // Fallback for non-OpenAI providers
        logger.warn('Non-OpenAI TTS provider requested but not implemented, using placeholder', {
          storyId,
          chapterNumber,
          provider: config.provider
        });
        
        audioBuffer = Buffer.from('placeholder-audio-data');
        actualVoice = config.voice;
        actualModel = config.model;
      }

      // Upload chapter audio to storage with chapter filename
      const audioFilename = getAudioFilename(storyId, chapterNumber);
      const audioUrl = await this.storageService.uploadFile(
        audioFilename,
        audioBuffer,
        'audio/mpeg'
      );

      // Update story audiobookUri with this chapter's audio
      await this.updateStoryAudiobookUri(storyId, chapterNumber, audioUrl);

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