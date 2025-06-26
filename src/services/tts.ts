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
import { countWords } from '@/shared/utils.js';

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

export interface TTSConfig {
  provider: 'openai' | 'vertex';
  model: string;
  voice: string;
  speed: number;
  language: string;
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
   * Get TTS configuration from environment variables
   */  private getTTSConfig(): TTSConfig {
    return {
      provider: (process.env.TTS_PROVIDER || 'openai') as 'openai' | 'vertex',
      model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.TTS_VOICE || 'nova',
      speed: parseFloat(process.env.TTS_SPEED || '0.9'),
      language: process.env.TTS_LANGUAGE || 'en-US'
    };
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
      const config = this.getTTSConfig();

      // Get the specific chapter
      const chapterStep = await this.runsService.getStepResult(runId, `write_chapter_${chapterNumber}`);
      if (!chapterStep?.detailJson) {
        throw new Error(`Chapter ${chapterNumber} not found`);
      }

      const chapterData = chapterStep.detailJson as Record<string, unknown>;
      const chapterContent = chapterData.chapter as string || '';      // Use story language from the story record
      const storyLanguage = story.storyLanguage || 'en-US';
      
      // Load audio prompt configuration for the story language
      const audioPromptConfig = await AudioPromptService.getTTSInstructions(
        storyLanguage,
        undefined // We'll use default target age since it's not in the story schema
      );

      // Prepare chapter text for TTS
      let chapterText = this.prepareChapterTextForTTS(
        story.title || 'Untitled Story',
        chapterNumber,
        chapterContent
      );      // Enhance text with audio prompts if available
      if (audioPromptConfig) {
        logger.info('Applying audio prompt configuration', {
          runId,
          chapterNumber,
          language: audioPromptConfig.language,
          languageName: audioPromptConfig.languageName
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
          undefined // Target age not available in current schema
        );
        
        const recommendedSpeed = AudioPromptService.getRecommendedSpeed(
          undefined, // Target age not available in current schema
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
          originalSpeed: process.env.TTS_SPEED
        });
      } else {
        logger.warn('No audio prompt configuration found, using basic TTS', {
          runId,
          chapterNumber,
          storyLanguage
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

      // Upload chapter audio to storage
      const audioFilename = `${run.storyId}/audio/chapter_${chapterNumber}.mp3`;
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
        duration: this.estimateDuration(chapterText),
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

      const config = this.getTTSConfig();
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
   * Prepare chapter text for TTS
   */  private prepareChapterTextForTTS(storyTitle: string, chapterNumber: number, chapterContent: string): string {
    // Start with chapter introduction including story title if it's the first chapter
    let text = '';
    if (chapterNumber === 1) {
      text = `${storyTitle}. Chapter ${chapterNumber}.\n\n`;
    } else {
      text = `Chapter ${chapterNumber}.\n\n`;
    }
    
    // Process chapter content for better TTS pronunciation
    const processedContent = this.processTextForTTS(chapterContent);
    text += processedContent;

    // Ensure text is within OpenAI TTS limits (4096 characters)
    if (text.length > 4000) {
      logger.warn('Chapter text exceeds recommended length, truncating', {
        originalLength: text.length,
        chapterNumber
      });
      
      // Truncate at sentence boundary
      const truncated = text.substring(0, 3800);
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?')
      );
      
      if (lastSentenceEnd > 0) {
        text = truncated.substring(0, lastSentenceEnd + 1);
      } else {
        text = truncated + '...';
      }
    }

    return text;
  }

  /**
   * Process text to optimize for TTS pronunciation and flow
   */
  private processTextForTTS(text: string): string {
    // Apply TTS best practices
    return text
      // Add natural pauses with commas for better breathing
      .replace(/([.!?])\s+/g, '$1 ')
      // Handle numbers - spell out small numbers
      .replace(/\b(\d{1,2})\b/g, (match, num) => {
        const number = parseInt(num);
        const words = [
          'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
          'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 
          'seventeen', 'eighteen', 'nineteen', 'twenty'
        ];
        return number <= 20 && words[number] ? words[number] : match;
      })
      // Add pauses for dramatic effect
      .replace(/\.\.\./g, '... ')
      // Ensure proper punctuation for pauses
      .replace(/([,;:])\s*/g, '$1 ')
      // Clean up extra spaces
      .replace(/\s+/g, ' ')
      .trim();
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
      });      const response = await this.openaiClient.audio.speech.create({
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

  private estimateDuration(text: string): number {
    // Rough estimation: average speaking rate is ~150 words per minute
    const wordCount = countWords(text);
    const wordsPerMinute = 150;
    return Math.ceil((wordCount / wordsPerMinute) * 60); // return seconds
  }

  /**
   * Generate audio narration for a single chapter from provided text content
   * This is used for standalone audiobook generation from HTML content
   */
  async generateChapterAudioFromText(
    storyId: string,
    chapterNumber: number,
    chapterContent: string,
    storyTitle: string,
    voice?: string
  ): Promise<TTSChapterResult> {
    try {
      logger.info('Starting TTS generation for chapter from text', {
        storyId,
        chapterNumber,
        voice
      });      // Get story details to check language
      const story = await this.storyService.getStory(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }      logger.info('Starting audio generation for chapter from text', { 
        storyId, 
        chapterNumber,
        voice: voice || 'nova'
      });

      // Get TTS configuration
      const config = this.getTTSConfig();
      if (voice) {
        config.voice = voice;
      }      // Use story language from the story record
      const storyLanguage = story.storyLanguage || 'en-US';
        // Load audio prompt configuration for the story language
      const audioPromptConfig = await AudioPromptService.getTTSInstructions(
        storyLanguage,
        undefined // We'll use default target age since it's not in the story schema
      );

      // Prepare chapter text for TTS
      let chapterText = this.prepareChapterTextForTTS(
        storyTitle,
        chapterNumber,
        chapterContent
      );

      // Enhance text with audio prompts if available
      if (audioPromptConfig) {
        logger.info('Applying audio prompt configuration', {
          storyId,
          chapterNumber,
          language: audioPromptConfig.language,
          languageName: audioPromptConfig.languageName
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
          storyLanguage
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
        const result = await this.synthesizeSpeechVertex(chapterText, config, storyLanguage);
        audioBuffer = result.buffer;
        actualVoice = result.voice;
        actualModel = result.model;
      }

      // Upload chapter audio to storage
      const audioFilename = `${storyId}/audio/chapter_${chapterNumber}.mp3`;
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
        duration: this.estimateDuration(chapterText),
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

      logger.info('TTS generation completed for chapter from text', {
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
      logger.error('TTS generation failed for chapter from text', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber
      });
      throw error;
    }
  }

}
