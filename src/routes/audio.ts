import express from 'express';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { TTSService } from '@/services/tts.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';

const router = express.Router();
const storyService = new StoryService();
const storageService = getStorageService();
const workflowsAdapter = new GoogleCloudWorkflowsAdapter();

/**
 * POST /audio/create-audiobook
 * Trigger standalone audiobook generation for a story
 */
router.post(
  '/create-audiobook',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { storyId, voice } = req.body;

      if (!storyId) {
        res.status(400).json({
          success: false,
          error: 'storyId is required',
        });
        return;
      }
      logger.info('Audio API: Creating audiobook', { storyId, voice });

      // Trigger the audiobook generation workflow via Cloud Workflows
      const workflowParameters = {
        storyId,
        voice: voice || 'coral',
      };

      try {
        const executionId = await workflowsAdapter.executeWorkflow(
          'audiobook-generation',
          workflowParameters,
        );

        logger.info('Audio API: Audiobook generation workflow executed successfully', {
          storyId,
          voice,
          executionId,
        });

        res.json({
          success: true,
          message: 'Audiobook generation started',
          storyId,
          voice: voice || 'nova',
          status: 'processing',
          executionId,
        });
      } catch (workflowError) {
        logger.error('Audio API: Failed to execute audiobook workflow', {
          storyId,
          voice,
          error: workflowError instanceof Error ? workflowError.message : String(workflowError),
        });

        res.status(500).json({
          success: false,
          error: 'Failed to start audiobook generation workflow',
        });
        return;
      }
    } catch (error) {
      logger.error('Audio API: Failed to create audiobook', {
        error: error instanceof Error ? error.message : String(error),
        storyId: req.body.storyId,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

/**
 * POST /internal/audiobook/chapter
 * Generate audio for a single chapter from HTML content
 */
router.post(
  '/internal/audiobook/chapter',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const {
        storyId,
        chapterNumber,
        chapterTitle,
        chapterContent,
        storyTitle,
        storyAuthor,
        dedicatoryMessage,
        voice,
        storyLanguage,
        isFirstChapter,
        includeBackgroundMusic,
      } = req.body;

      logger.info('Internal API: Generating chapter audio', {
        storyId,
        chapterNumber,
        requestedVoice: voice,
        storyLanguage,
        isFirstChapter,
        includeBackgroundMusic,
        contentLength: chapterContent?.length || 0,
        hasTitle: !!chapterTitle,
        hasAuthor: !!storyAuthor,
        hasDedicatory: !!dedicatoryMessage,
      });

      // Validate required parameters
      if (!storyId || !chapterNumber || !chapterContent || !storyTitle) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameters: storyId, chapterNumber, chapterContent, storyTitle',
        });
        return;
      }

      // Initialize TTS service
      const ttsService = new TTSService();

      // Call the proper TTS service method that handles all language logic
      const result = await ttsService.generateChapterAudioFromText(
        storyId,
        chapterNumber,
        chapterContent,
        storyTitle,
        voice,
        'chapter',
        {
          storyAuthor,
          dedicatoryMessage,
          storyLanguage,
          isFirstChapter: isFirstChapter === true || isFirstChapter === 'true',
          includeBackgroundMusic:
            includeBackgroundMusic !== false && includeBackgroundMusic !== 'false',
          chapterTitle,
        },
      );

      logger.info('Chapter audio generated successfully', {
        storyId,
        chapterNumber,
        audioUrl: result.audioUrl,
        duration: result.duration,
        provider: result.provider,
        voice: result.voice,
        wordCount: result.metadata.totalWords,
      });

      res.json({
        success: true,
        chapterNumber: result.chapterNumber,
        audioUrl: result.audioUrl,
        duration: result.duration,
        format: result.format,
        provider: result.provider,
        voice: result.voice,
        metadata: result.metadata,
      });
    } catch (error) {
      logger.error('Failed to generate chapter audio', {
        error: error instanceof Error ? error.message : String(error),
        storyId: req.body.storyId,
        chapterNumber: req.body.chapterNumber,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

/**
 * POST /internal/audiobook/finalize
 * Finalize audiobook generation and update story
 */
router.post(
  '/internal/audiobook/finalize',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { storyId, chapters: providedChapters } = req.body as {
        storyId?: string;
        chapters?: Array<{
          chapterNumber?: number;
          chapterTitle?: string;
          audioUrl?: string;
          duration?: number;
          imageUri?: string;
        }>;
      };

      logger.info('Internal API: Finalizing audiobook', { storyId });

      if (!storyId) {
        res.status(400).json({
          success: false,
          error: 'storyId is required to finalize audiobook',
        });
        return;
      }

      const audioFiles: Record<number, string> = {};
      let totalDuration = 0;

      if (Array.isArray(providedChapters) && providedChapters.length > 0) {
        providedChapters.forEach((chapter, idx) => {
          if (!chapter?.audioUrl) return;
          const chapterNumber = chapter.chapterNumber ?? idx + 1;
          audioFiles[chapterNumber] = chapter.audioUrl;
          if (typeof chapter.duration === 'number' && chapter.duration > 0) {
            totalDuration += chapter.duration;
          }
        });
      } else {
        let chapterNumber = 1;
        while (true) {
          try {
            const audioFilename = `${storyId}/audio/chapter_${chapterNumber}.mp3`;
            const exists = await storageService.fileExists(audioFilename);

            if (exists) {
              const audioUrl = await storageService.getPublicUrl(audioFilename);
              audioFiles[chapterNumber] = audioUrl;
              totalDuration += 0;
              chapterNumber++;
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      }

      const audiobookChapters = Object.keys(audioFiles)
        .map((key) => parseInt(key, 10))
        .sort((a, b) => a - b)
        .map((chapterNumber) => ({
          chapterTitle: `Chapter ${chapterNumber}`,
          audioUri: audioFiles[chapterNumber],
          duration: 0,
        }));

      await storyService.updateStoryUris(storyId, {
        audiobookUri: audiobookChapters,
      });

      logger.info('Internal API: Audiobook finalization completed', {
        storyId,
        chaptersProcessed: audiobookChapters.length,
        totalDuration,
      });

      res.json({
        success: true,
        storyId,
        audioUrls: audioFiles,
        audiobookChapters,
        totalDuration,
        chaptersProcessed: audiobookChapters.length,
      });
    } catch (error) {
      logger.error('Internal API: Failed to finalize audiobook', {
        error: error instanceof Error ? error.message : String(error),
        storyId: req.body.storyId,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

export { router as audioRouter };
export default router;
