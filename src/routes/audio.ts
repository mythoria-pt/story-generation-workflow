import express from 'express';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { StorageService } from '@/services/storage.js';
import { AudioPromptService } from '@/services/audio-prompt.js';
import { tokenUsageTrackingService } from '@/services/token-usage-tracking.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import { parse, HTMLElement } from 'node-html-parser';
import OpenAI from 'openai';

const router = express.Router();
const storyService = new StoryService();
const storageService = new StorageService();
const workflowsAdapter = new GoogleCloudWorkflowsAdapter();

interface ChapterContent {
  title: string;
  content: string;
}

/**
 * POST /audio/create-audiobook
 * Trigger standalone audiobook generation for a story
 */
router.post('/create-audiobook', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { storyId, voice } = req.body;

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'storyId is required'
      });
      return;
    }    logger.info('Audio API: Creating audiobook', { storyId, voice });

    // Trigger the audiobook generation workflow via Cloud Workflows
    const workflowParameters = {
      storyId,
      voice: voice || 'nova'
    };

    try {
      const executionId = await workflowsAdapter.executeWorkflow('audiobook-generation', workflowParameters);
      
      logger.info('Audio API: Audiobook generation workflow executed successfully', {
        storyId,
        voice,
        executionId
      });

      res.json({
        success: true,
        message: 'Audiobook generation started',
        storyId,
        voice: voice || 'nova',
        status: 'processing',
        executionId
      });
    } catch (workflowError) {
      logger.error('Audio API: Failed to execute audiobook workflow', {
        storyId,
        voice,
        error: workflowError instanceof Error ? workflowError.message : String(workflowError)
      });

      res.status(500).json({
        success: false,
        error: 'Failed to start audiobook generation workflow'
      });
      return;
    }

  } catch (error) {
    logger.error('Audio API: Failed to create audiobook', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /internal/stories/:storyId/html
 * Get story HTML and extract chapter content for TTS
 */
router.get('/internal/stories/:storyId/html', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const storyId = req.params.storyId;

    logger.info('Internal API: Getting story HTML for audiobook', { storyId });

    // Download HTML file from storage
    const htmlFilename = `${storyId}/story.html`;
    const htmlContent = await storageService.downloadFile(htmlFilename);
    
    if (!htmlContent) {
      res.status(404).json({
        success: false,
        error: 'Story HTML not found'
      });
      return;
    }

    // Parse HTML and extract chapters
    const root = parse(htmlContent);
    const chapters: ChapterContent[] = [];

    // Extract chapters from HTML
    const chapterElements = root.querySelectorAll('.mythoria-chapter');
    
    for (const chapterElement of chapterElements) {
      const titleElement = chapterElement.querySelector('.mythoria-chapter-title');
      const contentElement = chapterElement.querySelector('.mythoria-chapter-content');
      
      if (titleElement && contentElement) {
        const title = titleElement.text.trim();        // Extract text content, removing HTML tags and cleaning up
        const paragraphs = contentElement.querySelectorAll('.mythoria-chapter-paragraph');
        const content = paragraphs
          .map((p: HTMLElement) => p.text.trim())
          .filter((text: string) => text && !text.startsWith('#')) // Remove markdown headers
          .join('\n\n');

        if (content) {
          chapters.push({
            title,
            content
          });
        }
      }
    }

    logger.info('Internal API: Extracted chapters from HTML', {
      storyId,
      chaptersFound: chapters.length
    });

    res.json({
      success: true,
      storyId,
      chapters
    });

  } catch (error) {
    logger.error('Internal API: Failed to get story HTML', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params.storyId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/audiobook/chapter
 * Generate audio for a single chapter from HTML content
 */
router.post('/internal/audiobook/chapter', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { storyId, chapterNumber, chapterContent, storyTitle, voice, language } = req.body;

    logger.info('Internal API: Generating chapter audio from HTML', {
      storyId,
      chapterNumber,
      voice,
      language,
      contentLength: chapterContent?.length || 0
    });

    // Validate required parameters
    if (!storyId || !chapterNumber || !chapterContent) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: storyId, chapterNumber, chapterContent'
      });
      return;
    }

    // Get story details to obtain full context
    const story = await storyService.getStory(storyId);
    if (!story) {
      res.status(404).json({
        success: false,
        error: `Story not found: ${storyId}`
      });
      return;
    }

    // Use story language if provided, otherwise fall back to parameter or default
    const storyLanguage = story.storyLanguage || language || 'en-US';
    const actualStoryTitle = story.title || storyTitle || 'Untitled Story';

    // Load audio prompt configuration for the story language
    const audioPromptConfig = await AudioPromptService.getTTSInstructions(
      storyLanguage,
      undefined // Target age not available in current schema
    );

    // Prepare chapter text for TTS
    let chapterText = '';
    if (chapterNumber === 1) {
      chapterText = `${actualStoryTitle}. Chapter ${chapterNumber}.\n\n`;
    } else {
      chapterText = `Chapter ${chapterNumber}.\n\n`;
    }
    
    // Process chapter content for better TTS pronunciation
    const processedContent = chapterContent
      .replace(/([.!?])\s+/g, '$1 ')
      .replace(/\.\.\./g, '... ')
      .replace(/([,;:])\s*/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
    
    chapterText += processedContent;    // Get TTS configuration
    const config = {
      provider: (process.env.TTS_PROVIDER || 'openai') as 'openai' | 'vertex',
      model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: voice || process.env.TTS_VOICE || 'nova',
      speed: parseFloat(process.env.TTS_SPEED || '0.9'),
      language: storyLanguage
    };

    // Apply audio prompt enhancements if available
    if (audioPromptConfig) {
      logger.info('Applying audio prompt configuration', {
        storyId,
        chapterNumber,
        language: audioPromptConfig.language,
        languageName: audioPromptConfig.languageName
      });

      // Enhance text using audio prompts
      chapterText = AudioPromptService.enhanceTextForTTS(
        chapterText,
        audioPromptConfig.systemPrompt,
        audioPromptConfig.instructions
      );

      // Get recommended voice and speed based on audio prompts
      const recommendedVoice = AudioPromptService.getRecommendedVoice(
        audioPromptConfig.systemPrompt,
        storyLanguage
      );
      
      const recommendedSpeed = AudioPromptService.getRecommendedSpeed(
        undefined, // Target age not available
        audioPromptConfig.instructions
      );

      // Override config with recommendations (but allow explicit voice parameter to take precedence)
      if (!voice) {
        config.voice = recommendedVoice;
      }
      config.speed = recommendedSpeed;

      logger.info('Applied audio prompt recommendations', {
        storyId,
        chapterNumber,
        recommendedVoice,
        recommendedSpeed,
        finalVoice: config.voice
      });
    }

    // Ensure text is within OpenAI TTS limits (4096 characters)
    if (chapterText.length > 4000) {
      logger.warn('Chapter text exceeds recommended length, truncating', {
        originalLength: chapterText.length,
        chapterNumber,
        storyId
      });
      
      // Truncate at sentence boundary
      const truncated = chapterText.substring(0, 3800);
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?')
      );
      
      if (lastSentenceEnd > 0) {
        chapterText = truncated.substring(0, lastSentenceEnd + 1);
      } else {
        chapterText = truncated + '...';
      }
    }

    // Generate audio using TTS service
    let audioBuffer: Buffer;
    let actualVoice: string;
    let actualModel: string;

    if (config.provider === 'openai') {
      // Initialize OpenAI client
      const openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      logger.info('Generating TTS with OpenAI', {
        storyId,
        chapterNumber,
        model: config.model,
        voice: config.voice,
        speed: config.speed,
        textLength: chapterText.length
      });

      const response = await openaiClient.audio.speech.create({
        model: config.model as 'tts-1' | 'tts-1-hd',
        voice: config.voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
        input: chapterText,
        speed: config.speed,
        response_format: 'mp3'
      });

      audioBuffer = Buffer.from(await response.arrayBuffer());
      actualVoice = config.voice;
      actualModel = config.model;

      logger.info('OpenAI TTS generation completed', {
        storyId,
        chapterNumber,
        audioSize: audioBuffer.length,
        voice: actualVoice,
        model: actualModel
      });
    } else {
      // Fallback to placeholder for non-OpenAI providers
      logger.warn('Non-OpenAI TTS provider requested but not implemented, using placeholder', {
        storyId,
        chapterNumber,
        provider: config.provider
      });
      
      audioBuffer = Buffer.from('placeholder-audio-data');
      actualVoice = config.voice;
      actualModel = config.model;
    }

    // Upload audio to storage
    const audioFilename = `${storyId}/audio/chapter_${chapterNumber}.mp3`;
    const audioUrl = await storageService.uploadFile(
      audioFilename,
      audioBuffer,
      'audio/mpeg'
    );

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
          storyLanguage: storyLanguage
        }
      });

      logger.info('TTS token usage recorded', {
        storyId,
        chapterNumber,
        characters: chapterText.length,
        model: actualModel,
        authorId: story.authorId
      });
    } catch (error) {
      logger.error('Failed to record TTS token usage', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber
      });
      // Don't throw - we don't want to break TTS generation due to tracking failures
    }

    const result = {
      chapterNumber,
      audioUrl,
      duration: Math.ceil((chapterText.split(' ').length / 150) * 60), // 150 words per minute
      format: 'mp3',
      provider: config.provider,
      voice: actualVoice,
      metadata: {
        totalWords: chapterText.split(' ').length,
        generatedAt: new Date().toISOString(),
        model: actualModel,
        speed: config.speed,
        storyLanguage: storyLanguage,
        textLength: chapterText.length
      }
    };

    logger.info('Internal API: Chapter audio generation completed', {
      storyId,
      chapterNumber,
      audioUrl,
      duration: result.duration,
      provider: config.provider,
      voice: actualVoice
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Internal API: Failed to generate chapter audio', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      chapterNumber: req.body.chapterNumber,      stack: error instanceof Error ? error.stack : undefined
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/audiobook/finalize
 * Finalize audiobook generation and update story
 */
router.post('/internal/audiobook/finalize', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { storyId } = req.body;

    logger.info('Internal API: Finalizing audiobook', { storyId });

    // Get all chapter audio files from storage
    const audioUrls: Record<number, string> = {};
    let totalDuration = 0;
    let chapterNumber = 1;

    // Find all audio files for this story
    while (true) {
      try {
        const audioFilename = `${storyId}/audio/chapter_${chapterNumber}.mp3`;
        const exists = await storageService.fileExists(audioFilename);
        
        if (exists) {
          const audioUrl = await storageService.getPublicUrl(audioFilename);
          audioUrls[chapterNumber] = audioUrl;
          // Estimate 150 words per minute for duration calculation
          totalDuration += 60; // Default 1 minute per chapter
          chapterNumber++;
        } else {
          break;
        }
      } catch {
        break;
      }
    }    // Update story with audiobook URIs
    const audiobookUri = audioUrls as Record<string, string>; // Proper type cast
    await storyService.updateStoryUris(storyId, {
      audiobookUri
    });

    logger.info('Internal API: Audiobook finalization completed', {
      storyId,
      chaptersProcessed: Object.keys(audioUrls).length,
      totalDuration
    });

    res.json({
      success: true,
      storyId,
      audioUrls,
      totalDuration,
      chaptersProcessed: Object.keys(audioUrls).length
    });

  } catch (error) {
    logger.error('Internal API: Failed to finalize audiobook', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as audioRouter };
export default router;
