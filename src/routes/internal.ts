/**
 * Internal API Routes
 * Endpoints for story generation run management and workflow coordination
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { RunsService } from '@/services/runs.js';
import { AssemblyService } from '@/services/assembly.js';
import { TTSService } from '@/services/tts.js';
import { StorageService } from '@/services/storage.js';
import { ProgressTrackerService } from '@/services/progress-tracker.js';

const router = Router();

// Initialize services
const runsService = new RunsService();
const assemblyService = new AssemblyService();
const ttsService = new TTSService();
const storageService = new StorageService();
const progressTracker = new ProgressTrackerService();

// Request schemas
const UpdateRunRequestSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  currentStep: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const StoreOutlineRequestSchema = z.object({
  outline: z.record(z.unknown())
});

const StoreChapterRequestSchema = z.object({
  chapterNumber: z.number().int().positive(),
  chapter: z.string(),
  imagePrompts: z.array(z.string()).optional()
});

const StoreImageRequestSchema = z.object({
  chapterNumber: z.number().int().positive().optional(),
  imageType: z.enum(['front_cover', 'back_cover', 'chapter']),
  imageUrl: z.string().url(),
  filename: z.string(),
  metadata: z.record(z.unknown()).optional()
});



/**
 * PATCH /internal/runs/:runId
 * Update run status and metadata
 */
router.patch('/runs/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;
    const updates = UpdateRunRequestSchema.parse(req.body);

    logger.info('Internal API: Updating run', {
      runId,
      updates
    });

    const updatedRun = await runsService.updateRun(runId, updates);

    // Update progress percentage whenever a run is updated
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated', { runId });
    } catch (progressError) {
      // Don't fail the entire request if progress update fails
      logger.warn('Failed to update progress percentage', {
        runId,
        error: progressError instanceof Error ? progressError.message : String(progressError)
      });
    }

    logger.info('Internal API: Run updated successfully', {
      runId,
      status: updatedRun.status,
      currentStep: updatedRun.currentStep
    });

    res.json({
      success: true,
      run: updatedRun
    });

  } catch (error) {
    logger.error('Internal API: Failed to update run', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /internal/runs/:runId
 * Get run details with steps
 */
router.get('/runs/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;

    logger.debug('Internal API: Getting run', { runId });

    const run = await runsService.getRun(runId);
      if (!run) {
      res.status(404).json({
        success: false,
        error: 'Run not found'
      });
      return;
    }

    const steps = await runsService.getRunSteps(runId);

    res.json({
      success: true,
      run,
      steps
    });

  } catch (error) {
    logger.error('Internal API: Failed to get run', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /internal/prompts/:runId/:chapterNumber
 * Get chapter photo prompt from stored outline
 */
router.get('/prompts/:runId/:chapterNumber', async (req, res) => {
  try {
    const runId = req.params.runId;
    const chapterNumber = parseInt(req.params.chapterNumber);

    logger.debug('Internal API: Getting chapter prompt', { runId, chapterNumber });    // Get the outline step result to access chapter photo prompts
    const steps = await runsService.getRunSteps(runId);
    const outlineStep = steps.find(step => step.stepName === 'generate_outline');
    
    if (!outlineStep || !outlineStep.detailJson) {
      res.status(404).json({
        success: false,
        error: 'Outline not found for this run'
      });
      return;
    }

    const outline = outlineStep.detailJson as any;
    
    if (!outline.chapters || !Array.isArray(outline.chapters)) {
      res.status(400).json({
        success: false,
        error: 'Invalid outline structure - chapters not found'
      });
      return;
    }

    // Find the specific chapter
    const chapter = outline.chapters.find((ch: any) => ch.chapterNumber === chapterNumber);
    
    if (!chapter) {
      res.status(404).json({
        success: false,
        error: `Chapter ${chapterNumber} not found in outline`
      });
      return;
    }

    if (!chapter.chapterPhotoPrompt) {
      res.status(404).json({
        success: false,
        error: `No photo prompt found for chapter ${chapterNumber}`
      });
      return;
    }

    logger.debug('Internal API: Chapter prompt retrieved successfully', {
      runId,
      chapterNumber,
      promptLength: chapter.chapterPhotoPrompt.length
    });

    // Return the prompt in the format expected by the workflow
    res.json(chapter.chapterPhotoPrompt);

  } catch (error) {
    logger.error('Internal API: Failed to get chapter prompt', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      chapterNumber: req.params.chapterNumber
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/runs/:runId/outline
 * Store generated outline
 */
router.post('/runs/:runId/outline', async (req, res) => {
  try {
    const runId = req.params.runId;
    const { outline } = StoreOutlineRequestSchema.parse(req.body);

    logger.info('Internal API: Storing outline', {
      runId,
      outlineKeys: Object.keys(outline)
    });

    await runsService.storeStepResult(runId, 'generate_outline', {
      status: 'completed',
      result: outline
    });

    // Update progress percentage after storing outline
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after outline storage', { runId });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after outline storage', {
        runId,
        error: progressError instanceof Error ? progressError.message : String(progressError)
      });
    }

    res.json({
      success: true,
      runId,
      step: 'generate_outline'
    });

  } catch (error) {
    logger.error('Internal API: Failed to store outline', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/runs/:runId/chapter/:chapterNumber
 * Store generated chapter
 */
router.post('/runs/:runId/chapter/:chapterNumber', async (req, res) => {
  try {
    const runId = req.params.runId;
    const chapterNumber = parseInt(req.params.chapterNumber);
    const { chapter, imagePrompts } = StoreChapterRequestSchema.parse({
      ...req.body,
      chapterNumber
    });

    logger.info('Internal API: Storing chapter', {
      runId,
      chapterNumber,
      chapterLength: chapter.length,
      imagePromptsCount: imagePrompts?.length || 0
    });    await runsService.storeStepResult(runId, `write_chapter_${chapterNumber}`, {
      status: 'completed',
      result: {
        chapterNumber,
        chapter,
        imagePrompts
      }
    });

    // Update progress percentage after storing chapter
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after chapter storage', { runId, chapterNumber });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after chapter storage', {
        runId,
        chapterNumber,
        error: progressError instanceof Error ? progressError.message : String(progressError)
      });
    }

    res.json({
      success: true,
      runId,
      chapterNumber,
      step: `write_chapter_${chapterNumber}`
    });

  } catch (error) {
    logger.error('Internal API: Failed to store chapter', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      chapterNumber: req.params.chapterNumber
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});



/**
 * GET /internal/prompts/:runId/book-cover/:coverType
 * Get book cover prompt from outline
 */
router.get('/prompts/:runId/book-cover/:coverType', async (req, res) => {
  try {
    const runId = req.params.runId;
    const coverType = req.params.coverType;

    if (!['front', 'back'].includes(coverType)) {
      res.status(400).json({
        success: false,
        error: 'Cover type must be either "front" or "back"'
      });
      return;
    }

    logger.debug('Internal API: Getting book cover prompt', {
      runId,
      coverType
    });

    // Get the outline step result
    const outlineStep = await runsService.getStepResult(runId, 'generate_outline');

    if (!outlineStep?.detailJson) {
      res.status(404).json({
        success: false,
        error: 'Outline not found for this run'
      });
      return;
    }

    const outline = outlineStep.detailJson as any;
    const promptField = coverType === 'front' ? 'bookCoverPrompt' : 'bookBackCoverPrompt';
    
    if (!outline[promptField]) {
      res.status(404).json({
        success: false,
        error: `No ${coverType} cover prompt found in outline`
      });
      return;
    }

    logger.debug('Internal API: Book cover prompt retrieved successfully', {
      runId,
      coverType,
      promptLength: outline[promptField].length
    });

    // Return the prompt in the format expected by the workflow
    res.json(outline[promptField]);

  } catch (error) {
    logger.error('Internal API: Failed to get book cover prompt', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      coverType: req.params.coverType
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/assemble/:runId
 * Assemble story into final formats (HTML, PDF)
 */
router.post('/assemble/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;

    logger.info('Internal API: Assembling story', { runId });

    const result = await assemblyService.assembleStory(runId);

    await runsService.storeStepResult(runId, 'assemble', {
      status: 'completed',
      result
    });

    logger.info('Internal API: Story assembled successfully', {
      runId,
      formats: Object.keys(result.files)
    });

    res.json({
      success: true,
      runId,
      result,
      step: 'assemble'
    });

  } catch (error) {
    logger.error('Internal API: Failed to assemble story', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /internal/tts/:runId
 * Generate audio narration for story (per chapter)
 */
router.post('/tts/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;

    logger.info('Internal API: Generating TTS', { runId });

    const result = await ttsService.generateNarration(runId);

    await runsService.storeStepResult(runId, 'tts', {
      status: 'completed',
      result
    });

    logger.info('Internal API: TTS generated successfully', {
      runId,
      audioUrls: result.audioUrls,
      chaptersProcessed: result.metadata.chaptersProcessed
    });

    res.json({
      success: true,
      runId,
      result,
      step: 'tts'
    });

  } catch (error) {
    logger.error('Internal API: Failed to generate TTS', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /internal/diagnostics/storage
 * Test storage connection and configuration
 */
router.get('/diagnostics/storage', async (_req, res) => {
  try {
    logger.info('Running storage diagnostics');
    
    const result = await storageService.testConnection();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Storage connection test passed',
        ...result.details
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Storage connection test failed',
        error: result.details
      });
    }
  } catch (error) {
    logger.error('Storage diagnostics failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      message: 'Storage diagnostics failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /storage/test
 * Test storage connection and configuration
 */
router.get('/storage/test', async (_req, res) => {
  try {
    logger.info('Testing storage connection');
    
    const testResult = await storageService.testConnection();
    
    if (testResult.success) {
      logger.info('Storage test successful', testResult.details);
      res.json({
        success: true,
        message: 'Storage connection test passed',
        details: testResult.details
      });
    } else {
      logger.warn('Storage test failed', testResult.details);
      res.status(500).json({
        success: false,
        message: 'Storage connection test failed',
        details: testResult.details
      });
    }
  } catch (error) {
    logger.error('Storage test endpoint error', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      message: 'Storage test failed with exception',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /storage/info
 * Get bucket configuration and setup recommendations
 */
router.get('/storage/info', async (_req, res) => {
  try {
    logger.info('Getting storage bucket info');
    
    const bucketInfo = await storageService.getBucketInfo();
    
    res.json({
      success: true,
      ...bucketInfo
    });
  } catch (error) {
    logger.error('Storage info endpoint error', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to get storage info',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /internal/runs/:runId/image
 * Store generated image result
 */
router.post('/runs/:runId/image', async (req, res) => {
  try {
    const runId = req.params.runId;
    const { chapterNumber, imageType, imageUrl, filename, metadata } = StoreImageRequestSchema.parse(req.body);

    logger.info('Internal API: Storing image result', {
      runId,
      chapterNumber,
      imageType,
      filename
    });

    // Determine step name based on image type
    let stepName: string;
    if (imageType === 'front_cover') {
      stepName = 'generate_front_cover';
    } else if (imageType === 'back_cover') {
      stepName = 'generate_back_cover';
    } else if (imageType === 'chapter' && chapterNumber) {
      stepName = `generate_image_chapter_${chapterNumber}`;
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid image type or missing chapter number for chapter image'
      });
      return;
    }

    await runsService.storeStepResult(runId, stepName, {
      status: 'completed',
      result: {
        chapterNumber,
        imageType,
        imageUrl,
        filename,
        metadata
      }
    });

    // Update progress percentage after storing image result
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after image storage', { runId, stepName });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after image storage', {
        runId,
        stepName,
        error: progressError instanceof Error ? progressError.message : String(progressError)
      });
    }

    res.json({
      success: true,
      runId,
      step: stepName,
      imageType,
      chapterNumber
    });

  } catch (error) {
    logger.error('Internal API: Failed to store image result', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});



export { router as internalRouter };
