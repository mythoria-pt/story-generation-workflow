import express from 'express';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { StorageService } from '@/services/storage.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import { parse, HTMLElement } from 'node-html-parser';

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
    const { storyId, chapterNumber, chapterContent, storyTitle, voice } = req.body;

    logger.info('Internal API: Generating chapter audio from HTML', {
      storyId,
      chapterNumber,
      voice
    });

    // Create a simple TTS text
    let chapterText = '';
    if (chapterNumber === 1) {
      chapterText = `${storyTitle}. Chapter ${chapterNumber}.\n\n`;
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
    
    chapterText += processedContent;

    // Ensure text is within OpenAI TTS limits (4096 characters)
    if (chapterText.length > 4000) {
      logger.warn('Chapter text exceeds recommended length, truncating', {
        originalLength: chapterText.length,
        chapterNumber
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

    // For now, we'll create a placeholder response
    // In production, this would use OpenAI TTS or Google Cloud TTS
    const audioFilename = `${storyId}/audio/chapter_${chapterNumber}.mp3`;
    const audioUrl = await storageService.getPublicUrl(audioFilename);
    
    // Create a placeholder audio file (in production, this would be actual TTS)
    const placeholderAudio = Buffer.from('placeholder-audio-data');
    await storageService.uploadFile(audioFilename, placeholderAudio, 'audio/mpeg');

    const result = {
      chapterNumber,
      audioUrl,
      duration: Math.ceil((chapterText.split(' ').length / 150) * 60), // 150 words per minute
      format: 'mp3',
      provider: 'openai' as const,
      voice: voice || 'nova',
      metadata: {
        totalWords: chapterText.split(' ').length,
        generatedAt: new Date().toISOString(),
        model: 'tts-1',
        speed: 0.9
      }
    };

    logger.info('Internal API: Chapter audio generation completed', {
      storyId,
      chapterNumber,
      audioUrl,
      duration: result.duration
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Internal API: Failed to generate chapter audio', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      chapterNumber: req.body.chapterNumber
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
