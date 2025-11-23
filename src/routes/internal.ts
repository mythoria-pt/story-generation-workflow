/**
 * Internal API Routes
 * Endpoints for story generation run management and workflow coordination
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { RunsService } from '@/services/runs.js';
import { TTSService } from '@/services/tts.js';
import { ProgressTrackerService } from '@/services/progress-tracker.js';
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';

// Type for outline data structure
type OutlineData = {
  bookTitle: string;
  bookCoverPrompt: string;
  bookBackCoverPrompt: string;
  synopses: string;
  chapters: Array<{
    chapterNumber: number;
    chapterTitle: string;
    chapterSynopses: string;
    chapterPhotoPrompt: string;
  }>;
};

const router = Router();

// Initialize services
const runsService = new RunsService();
const ttsService = new TTSService();
const progressTracker = new ProgressTrackerService();
const storyService = new StoryService();
const chaptersService = new ChaptersService();

// Request schemas
const UpdateRunRequestSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'blocked']).optional(),
  currentStep: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  storyId: z.string().uuid().optional(), // Added to support creating missing runs
  startedAt: z.string().optional(),
});

const StoreOutlineRequestSchema = z.object({
  outline: z.record(z.string(), z.unknown()),
});

const StoreChapterRequestSchema = z.object({
  chapterNumber: z.number().int().positive(),
  chapter: z.string(),
  imagePrompts: z.array(z.string()).optional(),
  chapterTitle: z.string(), // Add chapter title
});

const StoreImageRequestSchema = z.object({
  chapterNumber: z.number().int().positive().optional(),
  imageType: z.enum(['front_cover', 'back_cover', 'chapter']),
  imageUrl: z.string().url(),
  filename: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GET /internal/auth/status
 * Returns whether the API key is configured (no secret value leakage)
 */
router.get('/auth/status', async (_req, res) => {
  const raw = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';
  const trimmed = raw.trim();
  res.json({
    success: true,
    apiKeyConfigured: trimmed.length > 0,
    keyLength: trimmed.length,
  });
});

/**
 * PATCH /internal/runs/:runId
 * Update run status and metadata
 */
router.patch('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = req.params.runId;
    if (!runId) {
      res.status(400).json({ success: false, error: 'Missing runId parameter' });
      return;
    }

    const updates = UpdateRunRequestSchema.parse(req.body);

    logger.info('Internal API: Updating run', {
      runId,
      updates,
    });

    // First check if run exists, create if missing (defensive programming)
    let run = await runsService.getRun(runId);
    if (!run && updates.storyId) {
      logger.warn('Run not found, creating new run', {
        runId,
        storyId: updates.storyId,
      });

      run = await runsService.createRun(updates.storyId, runId);
    } else if (!run) {
      logger.error('Run not found and no storyId provided', { runId });
      res.status(404).json({
        success: false,
        error: `Run not found: ${runId}. Please provide storyId to create missing run.`,
      });
      return;
    }

    const updatedRun = await runsService.updateRun(runId, updates);

    // Update progress percentage whenever a run is updated
    try {
      // Only update progress for active runs to avoid unnecessary processing
      if (updatedRun.status === 'running' || updatedRun.status === 'completed') {
        await progressTracker.updateStoryProgress(runId);
        logger.debug('Progress percentage updated', { runId });
      } else {
        logger.debug('Skipping progress update for inactive run', {
          runId,
          status: updatedRun.status,
        });
      }
    } catch (progressError) {
      // Don't fail the entire request if progress update fails
      logger.warn('Failed to update progress percentage', {
        runId,
        error: progressError instanceof Error ? progressError.message : String(progressError),
      });
    }

    logger.info('Internal API: Run updated successfully', {
      runId,
      status: updatedRun.status,
      currentStep: updatedRun.currentStep,
    });

    res.json({
      success: true,
      run: updatedRun,
    });
    return;
  } catch (error) {
    logger.error('Internal API: Failed to update run', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return;
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
        error: 'Run not found',
      });
      return;
    }

    const steps = await runsService.getRunSteps(runId);

    res.json({
      success: true,
      run,
      steps,
    });
  } catch (error) {
    logger.error('Internal API: Failed to get run', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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

    logger.debug('Internal API: Getting chapter prompt', { runId, chapterNumber }); // Get the outline step result to access chapter photo prompts
    const steps = await runsService.getRunSteps(runId);
    const outlineStep = steps.find((step) => step.stepName === 'generate_outline');

    if (!outlineStep || !outlineStep.detailJson) {
      res.status(404).json({
        success: false,
        error: 'Outline not found for this run',
      });
      return;
    }

    const outline = outlineStep.detailJson as OutlineData;

    if (!outline.chapters || !Array.isArray(outline.chapters)) {
      res.status(400).json({
        success: false,
        error: 'Invalid outline structure - chapters not found',
      });
      return;
    }

    // Find the specific chapter
    const chapter = outline.chapters.find((ch) => ch.chapterNumber === chapterNumber);

    if (!chapter) {
      res.status(404).json({
        success: false,
        error: `Chapter ${chapterNumber} not found in outline`,
      });
      return;
    }

    if (!chapter.chapterPhotoPrompt) {
      res.status(404).json({
        success: false,
        error: `No photo prompt found for chapter ${chapterNumber}`,
      });
      return;
    } // Get the story context to retrieve graphicalStyle (not needed now but left for future use)
    const enhancedPrompt = chapter.chapterPhotoPrompt;

    // Note: Style guidelines are now handled in the OpenAI image service itself
    // via the graphicalStyle option, so we don't add them here anymore

    logger.debug('Internal API: Chapter prompt retrieved successfully', {
      runId,
      chapterNumber,
      promptLength: enhancedPrompt.length,
      originalLength: chapter.chapterPhotoPrompt.length,
    });

    // Return the enhanced prompt in the format expected by the workflow
    res.json(enhancedPrompt);
  } catch (error) {
    logger.error('Internal API: Failed to get chapter prompt', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      chapterNumber: req.params.chapterNumber,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
      outlineKeys: Object.keys(outline),
    });

    await runsService.storeStepResult(runId, 'generate_outline', {
      status: 'completed',
      result: outline,
    });

    // Update progress percentage after storing outline
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after outline storage', { runId });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after outline storage', {
        runId,
        error: progressError instanceof Error ? progressError.message : String(progressError),
      });
    }

    res.json({
      success: true,
      runId,
      step: 'generate_outline',
    });
  } catch (error) {
    logger.error('Internal API: Failed to store outline', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
    const { chapter, imagePrompts, chapterTitle } = StoreChapterRequestSchema.parse({
      ...req.body,
      chapterNumber,
    });

    logger.info('Internal API: Storing chapter', {
      runId,
      chapterNumber,
      chapterLength: chapter.length,
      imagePromptsCount: imagePrompts?.length || 0,
    });

    // Get the run to extract storyId and authorId
    const run = await runsService.getRun(runId);
    if (!run) {
      res.status(404).json({
        success: false,
        error: 'Run not found',
      });
      return;
    }

    // Get story to extract authorId
    const story = await storyService.getStory(run.storyId);
    if (!story) {
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    // Save chapter to the main database
    const savedChapter = await chaptersService.saveChapter({
      storyId: run.storyId,
      authorId: story.authorId,
      chapterNumber,
      title: chapterTitle || `Chapter ${chapterNumber}`,
      htmlContent: chapter,
    });

    // Still save to workflow database for backward compatibility and workflow tracking
    await runsService.storeStepResult(runId, `write_chapter_${chapterNumber}`, {
      status: 'completed',
      result: {
        chapterNumber,
        chapter,
        imagePrompts,
        chapterTitle,
        chapterId: savedChapter.id, // Store reference to main database
      },
    });

    // Update progress percentage after storing chapter
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after chapter storage', { runId, chapterNumber });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after chapter storage', {
        runId,
        chapterNumber,
        error: progressError instanceof Error ? progressError.message : String(progressError),
      });
    }

    res.json({
      success: true,
      runId,
      chapterNumber,
      chapterId: savedChapter.id,
      version: savedChapter.version,
      step: `write_chapter_${chapterNumber}`,
    });
  } catch (error) {
    logger.error('Internal API: Failed to store chapter', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      chapterNumber: req.params.chapterNumber,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
        error: 'Cover type must be either "front" or "back"',
      });
      return;
    }

    logger.debug('Internal API: Getting book cover prompt', {
      runId,
      coverType,
    });

    // Get the outline step result
    const outlineStep = await runsService.getStepResult(runId, 'generate_outline');

    if (!outlineStep?.detailJson) {
      res.status(404).json({
        success: false,
        error: 'Outline not found for this run',
      });
      return;
    }

    const outline = outlineStep.detailJson as OutlineData;
    const promptField = coverType === 'front' ? 'bookCoverPrompt' : 'bookBackCoverPrompt';
    if (!outline[promptField]) {
      res.status(404).json({
        success: false,
        error: `No ${coverType} cover prompt found in outline`,
      });
      return;
    }

    // Get the story context to retrieve graphicalStyle (not needed now but left for future use)
    const enhancedPrompt = outline[promptField];

    // Note: Style guidelines are now handled in the OpenAI image service itself
    // via the graphicalStyle option, so we don't add them here anymore

    logger.debug('Internal API: Book cover prompt retrieved successfully', {
      runId,
      coverType,
      promptLength: enhancedPrompt.length,
      originalLength: outline[promptField].length,
    });

    // Return the enhanced prompt in the format expected by the workflow
    res.json(enhancedPrompt);
  } catch (error) {
    logger.error('Internal API: Failed to get book cover prompt', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
      coverType: req.params.coverType,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
    const { chapterNumber, imageType, imageUrl, filename, metadata } =
      StoreImageRequestSchema.parse(req.body);

    logger.info('Internal API: Storing image result', {
      runId,
      chapterNumber,
      imageType,
      filename,
    });

    // Get the run to extract storyId
    const run = await runsService.getRun(runId);
    if (!run) {
      res.status(404).json({
        success: false,
        error: 'Run not found',
      });
      return;
    }

    // Determine step name based on image type
    let stepName: string;
    if (imageType === 'front_cover') {
      stepName = 'generate_front_cover';
      // Update story cover URI
      await storyService.updateStoryCoverUris(run.storyId, {
        coverUri: imageUrl,
      });
    } else if (imageType === 'back_cover') {
      stepName = 'generate_back_cover';
      // Update story back cover URI
      await storyService.updateStoryCoverUris(run.storyId, {
        backcoverUri: imageUrl,
      });
    } else if (imageType === 'chapter' && chapterNumber) {
      stepName = `generate_image_chapter_${chapterNumber}`;
      // Update chapter image URI
      await chaptersService.updateChapterImage(run.storyId, chapterNumber, imageUrl);
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid image type or missing chapter number for chapter image',
      });
      return;
    }

    // Still save to workflow database for backward compatibility and workflow tracking
    await runsService.storeStepResult(runId, stepName, {
      status: 'completed',
      result: {
        chapterNumber,
        imageType,
        imageUrl,
        filename,
        metadata,
      },
    });

    // Update progress percentage after storing image result
    try {
      await progressTracker.updateStoryProgress(runId);
      logger.debug('Progress percentage updated after image storage', { runId, stepName });
    } catch (progressError) {
      logger.warn('Failed to update progress percentage after image storage', {
        runId,
        stepName,
        error: progressError instanceof Error ? progressError.message : String(progressError),
      });
    }

    res.json({
      success: true,
      runId,
      step: stepName,
      imageType,
      chapterNumber,
    });
  } catch (error) {
    logger.error('Internal API: Failed to store image result', {
      error: error instanceof Error ? error.message : String(error),
      runId: req.params.runId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /internal/stories/:storyId
 * Get story details for validation
 */
router.get('/stories/:storyId', async (req: Request, res: Response): Promise<void> => {
  try {
    const storyId = req.params.storyId;

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'storyId parameter is required',
      });
      return;
    }

    logger.info('Internal API: Getting story details', { storyId });

    const story = await storyService.getStory(storyId);

    if (!story) {
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    res.json({
      success: true,
      title: story.title,
      storyLanguage: story.storyLanguage,
      features: story.features,
    });
  } catch (error) {
    logger.error('Internal API: Failed to get story details', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params.storyId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /internal/stories/:storyId/html
 * Get story details and chapter content from database for audiobook generation
 */
router.get('/stories/:storyId/html', async (req: Request, res: Response): Promise<void> => {
  try {
    const storyId = req.params.storyId;

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'storyId parameter is required',
      });
      return;
    }

    logger.info('Internal API: Getting story chapters for audiobook', { storyId });

    // Get story details from database
    const story = await storyService.getStory(storyId);

    if (!story) {
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    // Get chapters from database (latest versions only)
    const chaptersFromDb = await chaptersService.getStoryChapters(storyId);

    if (!chaptersFromDb || chaptersFromDb.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No chapters found - story has not been generated yet',
      });
      return;
    }

    // Transform database chapters to the format expected by the workflow
    const chapters = chaptersFromDb.map((chapter) => ({
      title: chapter.title,
      content: chapter.htmlContent
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/&[^;]+;/g, ' ') // Replace HTML entities
        .trim(),
    }));

    logger.info('Internal API: Retrieved chapters from database', {
      storyId,
      chaptersFound: chapters.length,
      chapterTitles: chapters.map((ch) => ch.title),
    });

    res.json({
      success: true,
      storyId,
      chapters,
      title: story.title,
      author: story.author,
      dedicationMessage: story.dedicationMessage,
      storyLanguage: story.storyLanguage,
    });
  } catch (error) {
    logger.error('Internal API: Failed to get story HTML', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params.storyId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /internal/audiobook/chapter
 * Generate audio for a single chapter from HTML content
 */
router.post('/audiobook/chapter', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      storyId,
      chapterNumber,
      chapterContent,
      storyTitle,
      storyAuthor,
      dedicatoryMessage,
      voice,
      storyLanguage,
      isFirstChapter,
    } = req.body;

    logger.info('Internal API: Generating chapter audio', {
      storyId,
      chapterNumber,
      voice,
      storyLanguage,
      isFirstChapter,
      contentLength: chapterContent?.length || 0,
    });

    // Validate required parameters
    if (!storyId || !chapterNumber || !chapterContent) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: storyId, chapterNumber, chapterContent',
      });
      return;
    }

    // Generate TTS using the existing TTS service with enhanced parameters
    const result = await ttsService.generateChapterAudioFromText(
      storyId,
      chapterNumber,
      chapterContent,
      storyTitle || 'Untitled Story',
      voice,
      'chapter',
      {
        storyAuthor,
        dedicatoryMessage,
        storyLanguage,
        isFirstChapter,
      },
    );

    logger.info('Internal API: Chapter audio generation completed', {
      storyId,
      chapterNumber,
      audioUrl: result.audioUrl,
      duration: result.duration,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Internal API: Failed to generate chapter audio', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      chapterNumber: req.body.chapterNumber,
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /internal/audiobook/finalize
 * Finalize audiobook generation and update story
 */
router.post('/audiobook/finalize', async (req: Request, res: Response): Promise<void> => {
  try {
    const { storyId } = req.body;

    logger.info('Internal API: Finalizing audiobook', { storyId });

    // Get all chapters from database with their audio URIs
    const chaptersFromDb = await chaptersService.getStoryChapters(storyId);

    const audioUrls: Record<number, string> = {};
    let totalDuration = 0;

    // Build audio URLs from chapter audioUri fields
    for (const chapter of chaptersFromDb) {
      if (chapter.audioUri) {
        audioUrls[chapter.chapterNumber] = chapter.audioUri;
        totalDuration += 60; // Default 1 minute per chapter, could be enhanced to get actual duration
      }
    }

    // Update story hasAudio field
    await storyService.updateStoryUris(storyId, {
      hasAudio: Object.keys(audioUrls).length > 0,
    });

    logger.info('Internal API: Audiobook finalization completed', {
      storyId,
      chaptersProcessed: Object.keys(audioUrls).length,
      totalDuration,
    });

    res.json({
      success: true,
      storyId,
      audioUrls,
      totalDuration,
      chaptersProcessed: Object.keys(audioUrls).length,
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
});

// ============================================================================
// AUDIOBOOK STATUS MANAGEMENT
// ============================================================================

/**
 * PATCH /internal/stories/:storyId/audiobook-status
 * Update audiobook generation status for a story
 */
router.patch('/stories/:storyId/audiobook-status', async (req: Request, res: Response) => {
  try {
    const { storyId } = req.params;
    const { status, completedAt, failedAt, audioUrls, totalDuration } = req.body;

    // Validate storyId
    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'Story ID is required',
      });
      return;
    }

    // Validate status
    const validStatuses = ['generating', 'completed', 'failed'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
      return;
    }

    logger.info('Internal API: Updating audiobook status', {
      storyId,
      status,
      completedAt,
      failedAt,
      hasAudioUrls: !!audioUrls,
      totalDuration,
    });

    // Update story audiobook status
    const updateData: {
      audiobookStatus?: string;
      audiobookUri?: object;
    } = {};

    if (status) {
      updateData.audiobookStatus = status;
    }

    if (status === 'completed' && audioUrls) {
      updateData.audiobookUri = audioUrls;
    }

    // Update the story in the database
    await storyService.updateAudiobookStatus(storyId, updateData);

    logger.info('Internal API: Audiobook status updated successfully', {
      storyId,
      status,
      updateData,
    });

    res.json({
      success: true,
      storyId,
      status,
      updatedAt: new Date().toISOString(),
      ...(audioUrls && { audioUrls }),
      ...(totalDuration && { totalDuration }),
    });
  } catch (error) {
    logger.error('Internal API: Failed to update audiobook status', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params.storyId,
      requestBody: req.body,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export { router as internalRouter };
