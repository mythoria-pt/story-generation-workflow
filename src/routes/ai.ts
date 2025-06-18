/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { Router } from 'express';
import { AIGateway } from '../ai/gateway.js';
import { logger } from '@/config/logger.js';
import { z } from 'zod';
import {
  validateImageRequest,
  generateImageFilename,
  formatImageError
} from './ai-image-utils.js';
import { StoryService } from '@/services/story.js';
import { PromptService } from '@/services/prompt.js';
import { SchemaService } from '@/services/schema.js';
import { StorageService } from '@/services/storage.js';
import {
  getChapterCountForAudience,
  formatTargetAudience,
  getLanguageName,
  getStoryDescription,
  parseAIResponse
} from '@/shared/utils.js';

// Initialize services
const router = Router();
const aiGateway = AIGateway.fromEnvironment();
const storyService = new StoryService();
const storageService = new StorageService();

// Request schemas
const OutlineRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid()
});

const ChapterRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid().optional(), // Optional for testing/development
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterSynopses: z.string(),
  chapterCount: z.number().int().positive().optional(), outline: z.object({
    bookTitle: z.string(),
    bookCoverPrompt: z.string(),
    bookBackCoverPrompt: z.string(),
    synopses: z.string(),
    chapters: z.array(z.object({
      chapterNumber: z.number().int().positive(),
      chapterTitle: z.string(),
      chapterSynopses: z.string(),
      chapterPhotoPrompt: z.string()
    }))
  }).optional(),
  previousChapters: z.array(z.string()).optional()
});


/**
 * POST /ai/text/outline
 * Generate story outline using AI text generation with story context from database
 */
router.post('/text/outline', async (req, res) => {
  try {
    const { storyId, runId } = OutlineRequestSchema.parse(req.body);

    logger.info('AI Gateway: Generating story outline from database context', {
      storyId,
      runId
    });

    // Load story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: `Story not found: ${storyId}`
      });
      return;
    }    // Load prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-outline');    // Determine chapter count - use story's chapterCount if available, otherwise use audience-based default
    const chapterCount = getChapterCountForAudience(
      storyContext.story.targetAudience, 
      storyContext.story.chapterCount
    );

    // Prepare template variables
    const templateVars = {
      novelStyle: storyContext.story.novelStyle || 'adventure',
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      place: storyContext.story.place || 'a magical land',
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount, characters: JSON.stringify(
        storyContext.characters.map(char => ({
          name: char.name,
          type: char.type || '',
          role: char.role || '',
          passions: char.passions || '',
          superpowers: char.superpowers || '',
          physicalDescription: char.physicalDescription || ''
        })),
        null,
        2
      ),
      bookTitle: storyContext.story.title,
      storyDescription: getStoryDescription(storyContext as any),
      description: storyContext.story.plotDescription || 'No specific plot description provided.',
      graphicalStyle: storyContext.story.graphicalStyle || 'colorful and vibrant illustration',
      // Placeholder values for template completion
      bookCoverPrompt: 'A book cover prompt will be generated',
      bookBackCoverPrompt: 'A back cover prompt will be generated',
      synopses: 'Story synopsis will be generated',
      chapterNumber: '1',
      chapterPhotoPrompt: 'Chapter illustration prompt will be generated',
      chapterTitle: 'Chapter title will be generated',
      chapterSynopses: 'Chapter synopsis will be generated'
    };

    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);

    // Load JSON schema for structured output
    const storyOutlineSchema = await SchemaService.loadSchema('story-outline');

    // Generate outline using AI with specific outline model and JSON schema
    const outlineModel = process.env.VERTEX_AI_OUTLINE_MODEL || process.env.VERTEX_AI_MODEL_ID || 'gemini-2.0-flash';
    const requestOptions = {
      maxTokens: 8192,
      temperature: 1,
      model: outlineModel,
      jsonSchema: storyOutlineSchema
    };

    const outline = await aiGateway.getTextService().complete(finalPrompt, requestOptions);

    // Parse and validate the AI response
    const outlineData = parseAIResponse(outline);

    // Validate that the response matches our expected structure
    if (!outlineData.bookTitle || !outlineData.chapters || !Array.isArray(outlineData.chapters)) {
      throw new Error('Invalid outline structure received');
    }

    logger.info('AI Gateway: Story outline generated successfully', {
      storyId,
      runId,
      outlineLength: outline.length,
      storyTitle: storyContext.story.title,
      charactersCount: storyContext.characters.length
    });

    res.json({
      success: true,
      storyId,
      runId,
      outline: outlineData,
      storyContext: {
        title: storyContext.story.title,
        charactersCount: storyContext.characters.length
      }
    });
  } catch (error) {
    logger.error('AI Gateway: Outline generation failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body?.storyId,
      runId: req.body?.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /ai/text/chapter/:chapterNumber
 * Generate a specific chapter using AI text generation
 */
router.post('/text/chapter/:chapterNumber', async (req, res) => {
  try {
    const chapterNumber = parseInt(req.params.chapterNumber);
    const requestData = { ...req.body, chapterNumber };
    const { storyId, runId, chapterTitle, chapterSynopses, chapterCount } = ChapterRequestSchema.parse(requestData);

    // Validate chapter number if outline is provided
    if (req.body.outline?.chapters && Array.isArray(req.body.outline.chapters)) {
      const maxChapters = req.body.outline.chapters.length;
      if (chapterNumber < 1 || chapterNumber > maxChapters) {
        res.status(400).json({
          success: false,
          error: `Invalid chapter number ${chapterNumber}. Must be between 1 and ${maxChapters}.`
        });
        return;
      }
    }

    logger.info('AI Gateway: Generating chapter', {
      storyId,
      runId: runId || 'N/A',
      chapterNumber,
      chapterTitle
    });

    // Get story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }    // Load chapter prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-chapter');

    // Prepare template variables
    const hookInstruction = chapterCount && chapterNumber < chapterCount
      ? 'If relevant, you may end with a hook for the next chapter.'
      : '';

    const templateVariables = {
      chapterNumber: chapterNumber.toString(),
      chapterTitle: chapterTitle,
      novelStyle: storyContext.story.novelStyle || 'adventure',
      averageAge: formatTargetAudience(storyContext.story.targetAudience),
      description: storyContext.story.plotDescription || storyContext.story.synopsis || '',
      chapterSynopses: chapterSynopses,
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount: chapterCount?.toString() || '10',
      hookInstruction: hookInstruction
    };

    // Build the complete prompt
    const chapterPrompt = PromptService.buildPrompt(promptTemplate, templateVariables);

    // Generate chapter content
    const chapterText = await aiGateway.getTextService().complete(chapterPrompt, {
      maxTokens: 6000,
      temperature: 0.8
    });

    logger.info('AI Gateway: Chapter generated successfully', {
      storyId,
      runId: runId || 'N/A',
      chapterNumber,
      chapterLength: chapterText.length
    });

    res.json({
      success: true,
      storyId,
      runId: runId || null,
      chapterNumber,
      chapter: chapterText.trim()
    });

  } catch (error) {
    logger.error('AI Gateway: Chapter generation failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      runId: req.body.runId || 'N/A',
      chapterNumber: req.params.chapterNumber
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /ai/image
 * Generate an image using AI image generation and store it in Google Cloud Storage
 */
router.post('/image', async (req, res) => {
  let currentStep = 'parsing_request';
  try {
    const { prompt, storyId, runId, chapterNumber, imageType, width, height, style } =
      validateImageRequest(req.body);

    logger.info('AI Gateway: Generating image', {
      storyId,
      runId,
      chapterNumber,
      imageType,
      promptLength: prompt.length,
      dimensions: width && height ? `${width}x${height}` : 'default'
    });

    currentStep = 'generating_image';
    const imageBuffer = await aiGateway.getImageService().generate(prompt, {
      ...(width && { width }),
      ...(height && { height }),
      ...(style && { style })
    });

    logger.info('AI Gateway: Image generated successfully', {
      storyId,
      runId,
      chapterNumber,
      imageSize: imageBuffer.length
    });

    currentStep = 'preparing_upload';
    const filename = generateImageFilename({ storyId, imageType, chapterNumber });

    currentStep = 'uploading_to_storage';
    const imageUrl = await storageService.uploadFile(filename, imageBuffer, 'image/png');

    logger.info('AI Gateway: Image uploaded to storage', {
      storyId,
      runId,
      chapterNumber,
      filename,
      imageUrl,
      imageSize: imageBuffer.length
    });

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      image: {
        url: imageUrl,
        filename,
        format: 'png',
        size: imageBuffer.length
      }
    });
  } catch (error) {
    const errorDetails = formatImageError(error, req.body, currentStep);
    logger.error('AI Gateway: Image generation or upload failed', errorDetails);

    res.status(500).json({
      success: false,
      error: errorDetails.message,
      failedAt: currentStep,
      timestamp: errorDetails.timestamp,
      requestId: req.body.runId || 'unknown'
    });
  }
});

export { router as aiRouter };
