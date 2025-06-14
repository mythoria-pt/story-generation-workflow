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

const router = Router();

// Initialize services
const runsService = new RunsService();
const assemblyService = new AssemblyService();
const ttsService = new TTSService();
const storageService = new StorageService();

// Request schemas
const UpdateRunRequestSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  currentStep: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
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
  chapterNumber: z.number().int().positive(),
  imageData: z.string(), // base64 encoded
  imageUrl: z.string().optional(),
  prompt: z.string().optional()
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
    });

    await runsService.storeStepResult(runId, `write_chapter_${chapterNumber}`, {
      status: 'completed',
      result: {
        chapterNumber,
        chapter,
        imagePrompts
      }
    });

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
 * POST /internal/runs/:runId/chapter/:chapterNumber/image
 * Store generated image for chapter
 */
router.post('/runs/:runId/chapter/:chapterNumber/image', async (req, res) => {
  try {
    const runId = req.params.runId;
    const chapterNumber = parseInt(req.params.chapterNumber);
    const { imageData, imageUrl, prompt } = StoreImageRequestSchema.parse({
      ...req.body,
      chapterNumber
    });

    logger.info('Internal API: Storing chapter image', {
      runId,
      chapterNumber,
      hasImageData: !!imageData,
      hasImageUrl: !!imageUrl
    });

    // Upload image to storage if we have image data
    let finalImageUrl = imageUrl;
    if (imageData && !imageUrl) {
      const imageBuffer = Buffer.from(imageData, 'base64');
      const filename = `stories/${runId}/chapter-${chapterNumber}-image.png`;
      finalImageUrl = await storageService.uploadFile(filename, imageBuffer, 'image/png');
    }

    await runsService.storeStepResult(runId, `generate_image_${chapterNumber}`, {
      status: 'completed',
      result: {
        chapterNumber,
        imageUrl: finalImageUrl,
        prompt
      }
    });

    res.json({
      success: true,
      runId,
      chapterNumber,
      imageUrl: finalImageUrl,
      step: `generate_image_${chapterNumber}`
    });

  } catch (error) {
    logger.error('Internal API: Failed to store chapter image', {
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
 * Generate audio narration for story
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
      audioUrl: result.audioUrl
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

export { router as internalRouter };
