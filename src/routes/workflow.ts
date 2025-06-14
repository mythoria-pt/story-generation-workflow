import { Router } from 'express';
import { logger } from '@/config/logger.js';
import { z } from 'zod';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import {
  StoryOutlineHandler,
  ChapterWritingHandler,
  ImageGenerationHandler,
  FinalProductionHandler,
  AudioRecordingHandler
} from '@/workflows/handlers.js';

const router = Router();

// Initialize handlers
const storyOutlineHandler = new StoryOutlineHandler();
const chapterWritingHandler = new ChapterWritingHandler();
const imageGenerationHandler = new ImageGenerationHandler();
const finalProductionHandler = new FinalProductionHandler();
const audioRecordingHandler = new AudioRecordingHandler();

// Initialize Google Cloud Workflows adapter
const workflowsAdapter = new GoogleCloudWorkflowsAdapter();

// Request schema for workflow trigger
const WorkflowStartSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  prompt: z.string().optional() // Optional prompt for initial story request
});

/**
 * POST /workflow/start
 * Trigger the complete story generation workflow for a given story and run ID
 */
router.post('/start', async (req, res) => {
  try {
    const { storyId, runId, prompt } = WorkflowStartSchema.parse(req.body);

    logger.info('🚀 WORKFLOW TRIGGER: Starting complete story generation workflow', {
      storyId,
      runId,
      prompt: prompt?.substring(0, 100) + (prompt && prompt.length > 100 ? '...' : '')
    });

    // Prepare workflow parameters (simulating Pub/Sub message format)
    const workflowParameters = {
      data: Buffer.from(JSON.stringify({ 
        storyId, 
        runId,
        ...(prompt && { prompt })
      })).toString('base64')
    };

    // Execute the Google Cloud Workflow
    // Note: The workflow name should match what's deployed in Google Cloud
    const workflowName = 'story-generation';
    const executionId = await workflowsAdapter.executeWorkflow(workflowName, { event: workflowParameters });

    logger.info('✅ WORKFLOW TRIGGER: Workflow execution started successfully', {
      storyId,
      runId,
      executionId,
      workflowName
    });

    res.status(202).json({
      success: true,
      message: 'Story generation workflow started successfully',
      storyId,
      runId,
      executionId,
      workflowName,
      status: 'started'
    });

  } catch (error) {
    logger.error('❌ WORKFLOW TRIGGER: Failed to start workflow', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      runId: req.body.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start workflow',
      storyId: req.body.storyId,
      runId: req.body.runId
    });
  }
});

/**
 * GET /workflow/status/:executionId
 * Check the status of a workflow execution
 */
router.get('/status/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;

    logger.info('📊 WORKFLOW STATUS: Checking workflow execution status', {
      executionId
    });

    const executionResult = await workflowsAdapter.getWorkflowExecution(executionId);

    logger.info('✅ WORKFLOW STATUS: Retrieved execution status', {
      executionId,
      status: executionResult.status
    });    res.json({
      success: true,
      ...executionResult,
      executionId
    });

  } catch (error) {
    logger.error('❌ WORKFLOW STATUS: Failed to get execution status', {
      error: error instanceof Error ? error.message : String(error),
      executionId: req.params.executionId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get workflow status',
      executionId: req.params.executionId
    });
  }
});

// Story Outline Generation
router.post('/story-outline', async (req, res) => {
  try {
    const { storyId, workflowId, prompt } = req.body;
      logger.info('🔄 WORKFLOW STEP: Story Outline Generation started', {
      step: 'story-outline',
      storyId,
      workflowId,
      prompt: prompt?.substring(0, 100) + '...'
    });
    
    const result = await storyOutlineHandler.execute({ storyId, workflowId, prompt });
    
    logger.info('✅ WORKFLOW STEP: Story Outline Generation completed', {
      step: 'story-outline',
      storyId,
      workflowId,
      success: true
    });
    
    res.status(200).json({
      success: true,
      step: 'story-outline',
      storyId,
      workflowId,
      ...result
    });
  } catch (error) {    logger.error('❌ WORKFLOW STEP: Story Outline Generation failed', {
      step: 'story-outline',
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      step: 'story-outline',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Chapter Writing
router.post('/chapter-writing', async (req, res) => {
  try {
    const { storyId, workflowId, outline, chapterIndex = 0 } = req.body;
      logger.info('🔄 WORKFLOW STEP: Chapter Writing started', {
      step: 'chapter-writing',
      storyId,
      workflowId,
      chapterIndex
    });
    
    const result = await chapterWritingHandler.execute({ storyId, workflowId, outline, chapterIndex });
    
    logger.info('✅ WORKFLOW STEP: Chapter Writing completed', {
      step: 'chapter-writing',
      storyId,
      workflowId,
      success: true
    });
    
    res.status(200).json({
      success: true,
      step: 'chapter-writing',
      storyId,
      workflowId,
      ...result
    });
  } catch (error) {    logger.error('❌ WORKFLOW STEP: Chapter Writing failed', {
      step: 'chapter-writing',
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      step: 'chapter-writing',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Image Generation
router.post('/image-generation', async (req, res) => {
  try {
    const { storyId, workflowId, description = 'Story illustration', style } = req.body;
      logger.info('🔄 WORKFLOW STEP: Image Generation started', {
      step: 'image-generation',
      storyId,
      workflowId,
      description
    });
    
    const result = await imageGenerationHandler.execute({ storyId, workflowId, description, style });
    
    logger.info('✅ WORKFLOW STEP: Image Generation completed', {
      step: 'image-generation',
      storyId,
      workflowId,
      success: true
    });
    
    res.status(200).json({
      success: true,
      step: 'image-generation',
      storyId,
      workflowId,
      ...result
    });
  } catch (error) {    logger.error('❌ WORKFLOW STEP: Image Generation failed', {
      step: 'image-generation',
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      step: 'image-generation',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Final Production
router.post('/final-production', async (req, res) => {
  try {
    const { storyId, workflowId, chapters, images } = req.body;
      logger.info('🔄 WORKFLOW STEP: Final Production started', {
      step: 'final-production',
      storyId,
      workflowId,
      chaptersCount: chapters?.length || 0,
      imagesCount: images?.length || 0
    });
    
    const result = await finalProductionHandler.execute({ storyId, workflowId, chapters, images });
    
    logger.info('✅ WORKFLOW STEP: Final Production completed', {
      step: 'final-production',
      storyId,
      workflowId,
      success: true
    });
    
    res.status(200).json({
      success: true,
      step: 'final-production',
      storyId,
      workflowId,
      ...result
    });
  } catch (error) {    logger.error('❌ WORKFLOW STEP: Final Production failed', {
      step: 'final-production',
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(500).json({
      success: false,
      step: 'final-production',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Audio Recording (Optional)
router.post('/audio-recording', async (req, res) => {
  const { storyId, workflowId, content } = req.body;
  
  try {    logger.info('🔄 WORKFLOW STEP: Audio Recording started', {
      step: 'audio-recording',
      storyId,
      workflowId,
      contentLength: content?.length || 0
    });
    
    const result = await audioRecordingHandler.execute({ storyId, workflowId, content });
    
    logger.info('✅ WORKFLOW STEP: Audio Recording completed', {
      step: 'audio-recording',
      storyId,
      workflowId,
      success: true
    });
    
    res.status(200).json({
      success: true,
      step: 'audio-recording',
      storyId,
      workflowId,
      ...result
    });
  } catch (error) {    logger.error('❌ WORKFLOW STEP: Audio Recording failed', {
      step: 'audio-recording',
      error: error instanceof Error ? error.message : String(error)
    });
    
    res.status(200).json({
      success: true,
      step: 'audio-recording',
      storyId,
      workflowId,
      audioUrl: null,
      error: error instanceof Error ? error.message : 'Audio recording failed but workflow continues'
    });
  }
});

export { router };
export default router;
