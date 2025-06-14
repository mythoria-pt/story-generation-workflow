/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { Router } from 'express';
import { AIGateway } from '../ai/gateway.js';
import { logger } from '@/config/logger.js';
import { z } from 'zod';
import { StoryService, type StoryContext } from '@/services/story.js';
import { PromptService } from '@/services/prompt.js';

// Initialize services
const router = Router();
const aiGateway = AIGateway.fromEnvironment();
const storyService = new StoryService();

// Request schemas
const OutlineRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  chapterCount: z.number().int().positive().default(10),
  averageAge: z.number().int().positive().optional(),
  storyTone: z.string().optional()
});

const ChapterRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterSynopses: z.string(),
  chapterCount: z.number().int().positive().optional(),
  outline: z.object({
    title: z.string(),
    characters: z.array(z.string()),
    setting: z.string(),
    plotPoints: z.array(z.string())
  }).optional(),
  previousChapters: z.array(z.string()).optional()
});

const ImageRequestSchema = z.object({
  prompt: z.string().min(1),
  storyId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  chapterNumber: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  style: z.enum(['vivid', 'natural']).optional()
});

/**
 * POST /ai/text/outline
 * Generate story outline using AI text generation with story context from database
 */
router.post('/text/outline', async (req, res) => {
  try {
    const { storyId, runId, chapterCount, averageAge, storyTone } = OutlineRequestSchema.parse(req.body);

    logger.info('AI Gateway: Generating story outline from database context', {
      storyId,
      runId,
      chapterCount,
      averageAge,
      storyTone
    });

    // Load story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: `Story not found: ${storyId}`
      });
      return;
    }

    // Load prompt template
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-outline');

    // Prepare template variables
    const templateVars = {
      genre: storyContext.story.novelStyle || 'general fiction',
      storyTone: storyTone || 'engaging',
      averageAge: averageAge || 12,
      chapterCount,
      characters: JSON.stringify(storyContext.characters, null, 2),
      bookTitle: storyContext.story.title,
      storyDescription: getStoryDescription(storyContext),
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

    // Build the complete prompt
    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);

    logger.debug('Generated prompt for story outline', {
      storyId,
      runId,
      promptLength: finalPrompt.length,
      templateVarsCount: Object.keys(templateVars).length
    });    // Generate outline using AI with specific outline model
    const outlineModel = process.env.VERTEX_AI_OUTLINE_MODEL || process.env.VERTEX_AI_MODEL_ID || 'gemini-2.0-flash';
    const outline = await aiGateway.getTextService().complete(finalPrompt, {
      maxTokens: 8192,
      temperature: 1,
      model: outlineModel
    });

    // Try to parse as JSON, fallback to text if needed
    let outlineData;
    try {
      outlineData = JSON.parse(outline);
    } catch {
      outlineData = { rawOutline: outline };
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
      storyId: req.body.storyId,
      runId: req.body.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Helper function to generate story description
 */ 
function getStoryDescription(storyContext: StoryContext): string {
  const { story } = storyContext;
  let description = '';
  
  if (story.synopsis) {
    description += story.synopsis;
  } else if (story.plotDescription) {
    description += story.plotDescription;
  }
  
  if (story.place) {
    description += ` The story takes place in ${story.place}.`;
  }
  
  if (story.additionalRequests) {
    description += ` Additional requirements: ${story.additionalRequests}`;
  }
  
  return description || 'A story about the adventures and relationships of the main characters.';
}

/**
 * POST /ai/text/chapter/:chapterNumber
 * Generate a specific chapter using AI text generation
 */
router.post('/text/chapter/:chapterNumber', async (req, res) => {
  try {
    const chapterNumber = parseInt(req.params.chapterNumber);
    const requestData = { ...req.body, chapterNumber };
    const { storyId, runId, chapterTitle, chapterSynopses, chapterCount } = ChapterRequestSchema.parse(requestData);

    logger.info('AI Gateway: Generating chapter', {
      storyId,
      runId,
      chapterNumber,
      chapterTitle
    });    // Get story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // Load chapter prompt template
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-chapter');    // Prepare template variables
    const hookInstruction = chapterCount && chapterNumber < chapterCount 
      ? 'If relevant, you may end with a hook for the next chapter.'
      : '';
      
    const templateVariables = {
      chapterNumber: chapterNumber.toString(),
      chapterTitle: chapterTitle,
      genre: storyContext.story.novelStyle || 'adventure',
      storyTone: storyContext.story.novelStyle || 'engaging',
      averageAge: storyContext.story.targetAudience || '12',
      description: storyContext.story.plotDescription || storyContext.story.synopsis || '',
      chapterSynopses: chapterSynopses,
      language: 'English',
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
      runId,
      chapterNumber,
      chapterLength: chapterText.length
    });

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      chapter: chapterText.trim()
    });

  } catch (error) {
    logger.error('AI Gateway: Chapter generation failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      runId: req.body.runId,
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
 * Generate an image using AI image generation
 */
router.post('/image', async (req, res) => {
  try {
    const { prompt, storyId, runId, chapterNumber, width, height, style } = ImageRequestSchema.parse(req.body);

    logger.info('AI Gateway: Generating image', {
      storyId,
      runId,
      chapterNumber,
      promptLength: prompt.length,
      dimensions: width && height ? `${width}x${height}` : 'default'
    });    const imageBuffer = await aiGateway.getImageService().generate(prompt, {
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

    // Convert buffer to base64 for JSON response
    const base64Image = imageBuffer.toString('base64');

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      image: {
        data: base64Image,
        format: 'png',
        size: imageBuffer.length
      }
    });

  } catch (error) {
    logger.error('AI Gateway: Image generation failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body.storyId,
      runId: req.body.runId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as aiRouter };
