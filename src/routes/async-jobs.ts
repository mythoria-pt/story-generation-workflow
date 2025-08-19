/**
 * Async Job API Routes
 * RESTful endpoints for managing asynchronous AI editing jobs
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { jobManager, getEstimatedDuration } from '@/services/job-manager.js';

// Import existing processing functions (we'll create these)
import { processTextEditJob } from '@/workers/text-edit-worker.js';
import { processImageEditJob } from '@/workers/image-edit-worker.js';
import { processTranslationJob } from '@/workers/translation-worker.js';
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';

const router = Router();

// Request schemas
const TextEditJobSchema = z.object({
  storyId: z.string().min(1),
  userRequest: z.string().min(1).max(2000),
  scope: z.enum(['chapter', 'story']).optional().default('chapter'),
  chapterNumber: z.number().int().min(1).optional()
});

const ImageEditJobSchema = z.object({
  storyId: z.string().min(1),
  imageUrl: z.string().url(),
  imageType: z.enum(['cover', 'backcover', 'chapter']),
  userRequest: z.string().min(1).max(2000),
  chapterNumber: z.number().int().min(1).optional(),
  graphicalStyle: z.string().optional()
});

const TranslationJobSchema = z.object({
  storyId: z.string().min(1),
  targetLocale: z.enum([
    'en-US', 'en-GB',
    'pt-PT', 'pt-BR',
    'es-ES',
    'fr-FR',
    'it-IT',
    'de-DE',
    'nl-NL',
    'pl-PL'
  ])
});

/**
 * Enhanced error response helper
 */
function sendErrorResponse(res: any, statusCode: number, message: string, details?: any) {
  logger.error(`Async job error: ${message}`, details);
  
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(details && { details })
  });
}

/**
 * POST /jobs/text-edit
 * Create an async text editing job
 */
router.post('/text-edit', async (req, res) => {
  try {
    const { storyId, userRequest, scope, chapterNumber } = TextEditJobSchema.parse(req.body);

    logger.info('Text edit job request received', {
      storyId,
      scope,
      chapterNumber,
      userRequestLength: userRequest.length
    });

    // Determine chapter count for estimation (we'll need to get this from the story)
    // For now, assume single chapter unless scope is 'story'
    let chapterCount = 1;
    if (scope === 'story') {
      // TODO: Get actual chapter count from database
      // For now, estimate 5 chapters as default
      chapterCount = 5;
    }

    // Calculate estimated duration
    const estimatedDuration = getEstimatedDuration('text_edit', {
      operationType: scope,
      chapterCount
    });

    // Create job metadata without undefined values
    const metadata: any = {
      storyId,
      operationType: scope
    };
    if (scope === 'story' && chapterCount > 1) {
      metadata.chapterCount = chapterCount;
    }
    if (chapterNumber) {
      metadata.chapterNumber = chapterNumber;
    }

    // Create job
    const jobId = jobManager.createJob('text_edit', metadata, estimatedDuration);

    // Start processing in background
    const jobParams: any = {
      storyId,
      userRequest,
      scope
    };
    if (chapterNumber) {
      jobParams.chapterNumber = chapterNumber;
    }

    processTextEditJob(jobId, jobParams).catch((error: any) => {
      logger.error('Text edit job processing failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      jobManager.updateJobStatus(jobId, 'failed', undefined, 
        error instanceof Error ? error.message : 'Processing failed'
      );
    });

    // Return job ID immediately
    res.json({
      success: true,
      jobId,
      estimatedDuration,
      message: 'Text editing job created successfully'
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      sendErrorResponse(res, 400, 'Invalid request parameters', {
        validationErrors: error.errors
      });
    } else {
      sendErrorResponse(res, 500, 'Failed to create text edit job', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});

/**
 * POST /jobs/image-edit
 * Create an async image editing job
 */
router.post('/image-edit', async (req, res) => {
  try {
    const { storyId, imageUrl, imageType, userRequest, chapterNumber, graphicalStyle } = ImageEditJobSchema.parse(req.body);

    logger.info('Image edit job request received', {
      storyId,
      imageType,
      chapterNumber,
      userRequestLength: userRequest.length,
      hasGraphicalStyle: !!graphicalStyle
    });

    // Calculate estimated duration (always 90 seconds for images)
    const estimatedDuration = getEstimatedDuration('image_edit', {});

    // Create job metadata without undefined values
    const metadata: any = {
      storyId,
      operationType: 'image_edit',
      imageType
    };
    if (chapterNumber) {
      metadata.chapterNumber = chapterNumber;
    }

    // Create job
    const jobId = jobManager.createJob('image_edit', metadata, estimatedDuration);

    // Start processing in background
    const jobParams: any = {
      storyId,
      imageUrl,
      imageType,
      userRequest
    };
    if (chapterNumber) {
      jobParams.chapterNumber = chapterNumber;
    }
    if (graphicalStyle) {
      jobParams.graphicalStyle = graphicalStyle;
    }

    processImageEditJob(jobId, jobParams).catch((error: any) => {
      logger.error('Image edit job processing failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      jobManager.updateJobStatus(jobId, 'failed', undefined,
        error instanceof Error ? error.message : 'Processing failed'
      );
    });

    // Return job ID immediately
    res.json({
      success: true,
      jobId,
      estimatedDuration,
      message: 'Image editing job created successfully'
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      sendErrorResponse(res, 400, 'Invalid request parameters', {
        validationErrors: error.errors
      });
    } else {
      sendErrorResponse(res, 500, 'Failed to create image edit job', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});

/**
 * POST /jobs/translate-text
 * Create an async full story translation job
 */
router.post('/translate-text', async (req, res) => {
  try {
    const { storyId, targetLocale } = TranslationJobSchema.parse(req.body);

    const storyService = new StoryService();
    const chaptersService = new ChaptersService();

    // Load story and validate locale
    const story = await storyService.getStory(storyId);
    if (!story) {
      sendErrorResponse(res, 404, 'Story not found', { storyId });
      return;
    }
    if (story.storyLanguage === targetLocale) {
      sendErrorResponse(res, 400, 'Target locale matches current storyLanguage', {
        storyLanguage: story.storyLanguage,
        targetLocale
      });
      return;
    }

    // Determine chapter count for estimation
    const chapters = await chaptersService.getStoryChapters(storyId);
    const chapterCount = chapters.length || 1;

    // Estimate duration
    const estimatedDuration = getEstimatedDuration('text_translate', { chapterCount, operationType: 'story' });

    const metadata: any = {
      storyId,
      operationType: 'story',
      chapterCount,
      targetLocale
    };

    const jobId = jobManager.createJob('text_translate', metadata, estimatedDuration);

    // Start background processing
    processTranslationJob(jobId, { storyId, targetLocale }).catch((error: any) => {
      logger.error('Translation job processing failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      jobManager.updateJobStatus(jobId, 'failed', undefined,
        error instanceof Error ? error.message : 'Processing failed'
      );
    });

    res.json({
      success: true,
      jobId,
      estimatedDuration,
      message: 'Translation job created successfully'
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendErrorResponse(res, 400, 'Invalid request parameters', { validationErrors: error.errors });
    } else {
      sendErrorResponse(res, 500, 'Failed to create translation job', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});

/**
 * GET /jobs/:jobId
 * Get job status and progress
 */
router.get('/:jobId', async (req, res) => {
  try {
    const jobId = req.params.jobId;

    if (!jobId) {
      sendErrorResponse(res, 400, 'Job ID is required');
      return;
    }

    const job = jobManager.getJob(jobId);

    if (!job) {
      sendErrorResponse(res, 404, 'Job not found', { jobId });
      return;
    }

    // Calculate elapsed time and estimated remaining time
    const elapsedTime = Date.now() - job.startTime.getTime();
    const remainingTime = Math.max(0, job.estimatedDuration - elapsedTime);

    res.json({
      success: true,
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        elapsedTime,
        remainingTime,
        estimatedDuration: job.estimatedDuration,
        metadata: job.metadata,
        ...(job.result && { result: job.result }),
        ...(job.error && { error: job.error })
      }
    });

  } catch (error) {
    sendErrorResponse(res, 500, 'Failed to get job status', {
      jobId: req.params?.jobId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

export { router as asyncJobRouter };
