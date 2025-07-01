/**
 * Internal API Routes
 * Endpoints for story generation run management and workflow coordination
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/config/logger.js';
import { RunsService } from '@/services/runs.js';
import { AssemblyService } from '@/services/assembly.js';
import { TTSService } from '@/services/tts.js';
import { StorageService } from '@/services/storage.js';
import { ProgressTrackerService } from '@/services/progress-tracker.js';
import { StoryService } from '@/services/story.js';

const router = Router();

// Initialize services
const runsService = new RunsService();
const assemblyService = new AssemblyService();
const ttsService = new TTSService();
const storageService = new StorageService();
const progressTracker = new ProgressTrackerService();
const storyService = new StoryService();

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
    }    // Get the story context to retrieve graphicalStyle
    const run = await runsService.getRun(runId);
    let enhancedPrompt = chapter.chapterPhotoPrompt;
    
    if (run?.storyId) {
      const storyContext = await storyService.getStoryContext(run.storyId);
      
      if (storyContext?.story.graphicalStyle) {
        try {
          // Load the image styles configuration
          const imageStylesPath = join(process.cwd(), 'src', 'prompts', 'imageStyles.json');
          const imageStylesContent = await readFile(imageStylesPath, 'utf-8');
          const imageStyles = JSON.parse(imageStylesContent);
          
          const styleConfig = imageStyles[storyContext.story.graphicalStyle];
          if (styleConfig?.systemPrompt) {
            enhancedPrompt += ` Use the following style guidelines: ${styleConfig.systemPrompt}`;
          }
        } catch (styleError) {
          logger.warn('Failed to load image style guidelines', {
            error: styleError instanceof Error ? styleError.message : String(styleError),
            graphicalStyle: storyContext.story.graphicalStyle
          });
        }
      }
    }

    logger.debug('Internal API: Chapter prompt retrieved successfully', {
      runId,
      chapterNumber,
      promptLength: enhancedPrompt.length,
      originalLength: chapter.chapterPhotoPrompt.length,
      hasStyleGuidelines: enhancedPrompt.length > chapter.chapterPhotoPrompt.length
    });

    // Return the enhanced prompt in the format expected by the workflow
    res.json(enhancedPrompt);

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

    // Get the story context to retrieve graphicalStyle
    const run = await runsService.getRun(runId);
    let enhancedPrompt = outline[promptField];
    
    if (run?.storyId) {
      const storyContext = await storyService.getStoryContext(run.storyId);
      
      if (storyContext?.story.graphicalStyle) {
        try {
          // Load the image styles configuration
          const imageStylesPath = join(process.cwd(), 'src', 'prompts', 'imageStyles.json');
          const imageStylesContent = await readFile(imageStylesPath, 'utf-8');
          const imageStyles = JSON.parse(imageStylesContent);
          
          const styleConfig = imageStyles[storyContext.story.graphicalStyle];
          if (styleConfig?.systemPrompt) {
            enhancedPrompt += ` Use the following style guidelines: ${styleConfig.systemPrompt}`;
          }
        } catch (styleError) {
          logger.warn('Failed to load image style guidelines for book cover', {
            error: styleError instanceof Error ? styleError.message : String(styleError),
            graphicalStyle: storyContext.story.graphicalStyle,
            coverType
          });
        }
      }
    }

    logger.debug('Internal API: Book cover prompt retrieved successfully', {
      runId,
      coverType,
      promptLength: enhancedPrompt.length,
      originalLength: outline[promptField].length,
      hasStyleGuidelines: enhancedPrompt.length > outline[promptField].length
    });

    // Return the enhanced prompt in the format expected by the workflow
    res.json(enhancedPrompt);

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
    });    logger.info('Internal API: TTS request completed', {
      runId,
      audioUrls: result.audioUrls,
      chaptersProcessed: result.metadata.chaptersProcessed,
      audioGenerated: Object.keys(result.audioUrls).length > 0
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



/**
 * GET /internal/stories/:storyId
 * Get story details for validation
 */
router.get('/stories/:storyId', async (req: Request, res: Response): Promise<void> => {  try {
    const storyId = req.params.storyId;

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'storyId parameter is required'
      });
      return;
    }

    logger.info('Internal API: Getting story details', { storyId });

    const story = await storyService.getStory(storyId);
    
    if (!story) {
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    res.json({
      success: true,
      title: story.title,
      storyLanguage: story.storyLanguage,
      features: story.features
    });

  } catch (error) {
    logger.error('Internal API: Failed to get story details', {
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
 * GET /internal/stories/:storyId/html
 * Get story HTML and extract chapter content for TTS
 */
router.get('/stories/:storyId/html', async (req: Request, res: Response): Promise<void> => {
  try {
    const storyId = req.params.storyId;

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'storyId parameter is required'
      });
      return;
    }

    logger.info('Internal API: Getting story HTML for audiobook', { storyId });

    // Get story details from database to get the correct HTML URI
    const story = await storyService.getStory(storyId);
    
    if (!story) {
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    if (!story.htmlUri) {
      res.status(404).json({
        success: false,
        error: 'Story HTML not found - story has not been generated yet'
      });
      return;
    }

    // Extract the filename from the full GCS URI
    const urlParts = story.htmlUri.split('/');
    const bucketIndex = urlParts.findIndex(part => part === 'mythoria-generated-stories');
    const htmlFilename = urlParts.slice(bucketIndex + 1).join('/');
    
    const htmlContent = await storageService.downloadFile(htmlFilename);
    
    if (!htmlContent) {
      res.status(404).json({
        success: false,
        error: 'Story HTML file not found in storage'
      });
      return;
    }

    // Parse HTML and extract only actual chapters (no dedicatory or credits)
    const chapters: Array<{title: string, content: string}> = [];

    // Extract chapters using the mythoria-chapter class
    const chapterMatches = htmlContent.match(/<div class="mythoria-chapter"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="mythoria-page-break"|$)/g);
    
    if (chapterMatches) {
      chapterMatches.forEach((chapterHtml, index) => {
        // Extract title
        const titleMatch = chapterHtml.match(/<h2 class="mythoria-chapter-title"[^>]*>(.*?)<\/h2>/);
        const title = titleMatch?.[1]?.replace(/&[^;]+;/g, ' ').trim() || `Chapter ${index + 1}`;
        
        // Skip non-chapter content (dedicatory, credits)
        if (title.match(/dedicat|author|credit|attribution/i)) {
          logger.info('Skipping non-chapter content', { title, storyId });
          return;
        }
        
        // Extract content paragraphs
        const contentMatches = chapterHtml.match(/<p class="mythoria-chapter-paragraph"[^>]*>(.*?)<\/p>/g);
        let content = '';
        
        if (contentMatches) {
          content = contentMatches
            .map(p => p.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim())
            .filter(text => text && !text.startsWith('#'))
            .join('\n\n');
        }

        if (content) {
          chapters.push({ title, content });
        }
      });
    }

    // Also pass along story details for the workflow
    logger.info('Internal API: Extracted chapters from HTML', {
      storyId,
      chaptersFound: chapters.length,
      chapterTitles: chapters.map(ch => ch.title)
    });

    res.json({
      success: true,
      storyId,
      chapters,
      title: story.title,
      author: story.author,
      dedicationMessage: story.dedicationMessage,
      storyLanguage: story.storyLanguage
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
      isFirstChapter 
    } = req.body;

    logger.info('Internal API: Generating chapter audio', {
      storyId,
      chapterNumber,
      voice,
      storyLanguage,
      isFirstChapter,
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
        isFirstChapter
      }
    );

    logger.info('Internal API: Chapter audio generation completed', {
      storyId,
      chapterNumber,
      audioUrl: result.audioUrl,
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
      chapterNumber: req.body.chapterNumber,
      stack: error instanceof Error ? error.stack : undefined
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
router.post('/audiobook/finalize', async (req: Request, res: Response): Promise<void> => {
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
          totalDuration += 60; // Default 1 minute per chapter
          chapterNumber++;
        } else {
          break;
        }
      } catch {
        break;
      }
    }    // Update story with audiobook URIs
    const audiobookUri = audioUrls as Record<string, string>;
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
        error: 'Story ID is required'
      });
      return;
    }

    // Validate status
    const validStatuses = ['generating', 'completed', 'failed'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
      return;
    }

    logger.info('Internal API: Updating audiobook status', {
      storyId,
      status,
      completedAt,
      failedAt,
      hasAudioUrls: !!audioUrls,
      totalDuration
    });

    // Update story audiobook status
    const updateData: any = {};
    
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
      updateData
    });

    res.json({
      success: true,
      storyId,
      status,
      updatedAt: new Date().toISOString(),
      ...(audioUrls && { audioUrls }),
      ...(totalDuration && { totalDuration })
    });

  } catch (error) {
    logger.error('Internal API: Failed to update audiobook status', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params.storyId,
      requestBody: req.body
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as internalRouter };
