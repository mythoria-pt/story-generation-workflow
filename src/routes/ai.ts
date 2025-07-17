/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  validateImageRequest,
  generateImageFilename,
  formatImageError
} from './ai-image-utils.js';
import { StoryService } from '@/services/story.js';
import type { StoryContext } from '@/services/story.js';
import { PromptService } from '@/services/prompt.js';
import { SchemaService } from '@/services/schema.js';
import { StorageService } from '@/services/storage.js';
import { getImageDimensions } from '@/utils/imageUtils.js';
import { AIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';
import { logger } from '@/config/logger.js';
import {
  formatTargetAudience,
  getLanguageName,
  parseAIResponse
} from '@/shared/utils.js';

// Initialize services
const router = Router();
const aiGateway = AIGatewayWithTokenTracking.fromEnvironment();
const storyService = new StoryService();
const storageService = new StorageService();

/**
 * Generate image prompts for a chapter based on its content
 */
async function generateImagePromptsForChapter(
  chapterContent: string,
  storyContext: StoryContext,
  chapterNumber: number,
  chapterTitle: string,
  tokenTrackingContext: { authorId: string; storyId: string; action: 'chapter_writing' }
): Promise<string[]> {
  try {
    // Create a focused prompt to generate image prompts from the chapter content
    const imagePromptGenerationPrompt = `
You are an expert at creating detailed image prompts for book illustrations. Based on the following chapter content, create 1-3 detailed image prompts that would make compelling illustrations for this chapter.

Chapter Title: "${chapterTitle}"
Chapter Number: ${chapterNumber}
Story Genre: ${storyContext.story.novelStyle || 'adventure'}
Target Audience: ${formatTargetAudience(storyContext.story.targetAudience)}

Chapter Content:
${chapterContent}

Instructions:
1. Create 1-3 detailed image prompts that capture the most visual and engaging moments from this chapter
2. Focus on scenes with strong visual elements, character interactions, or dramatic moments
3. Each prompt should be detailed enough for an AI image generator to create a compelling illustration
4. Consider the target audience and genre when describing the visual style
5. Include details about characters, settings, lighting, mood, and composition
6. Each prompt should be 2-3 sentences long

Format your response as a JSON array of strings, like this:
["First detailed image prompt here", "Second detailed image prompt here", "Third detailed image prompt here"]

Return only the JSON array, no other text.
`;

    const imagePromptsResponse = await aiGateway.getTextService(tokenTrackingContext).complete(
      imagePromptGenerationPrompt,
      {
        maxTokens: 1024,
        temperature: 0.7
      }
    );

    // Parse the JSON response
    try {
      const imagePrompts = JSON.parse(imagePromptsResponse.trim()) as string[];
      
      // Validate that we got an array of strings
      if (!Array.isArray(imagePrompts) || !imagePrompts.every(prompt => typeof prompt === 'string')) {
        logger.warn('AI returned invalid image prompts format, falling back to default', {
          chapterNumber,
          response: imagePromptsResponse
        });
        return [`A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || 'adventure'} story.`];
      }

      logger.debug('Generated image prompts for chapter', {
        chapterNumber,
        promptCount: imagePrompts.length
      });

      return imagePrompts;
    } catch (parseError) {
      logger.warn('Failed to parse AI image prompts response, falling back to default', {
        chapterNumber,
        error: parseError instanceof Error ? parseError.message : String(parseError),
        response: imagePromptsResponse
      });
      return [`A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || 'adventure'} story.`];
    }
  } catch (error) {
    logger.error('Failed to generate image prompts for chapter', {
      chapterNumber,
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Return a fallback image prompt
    return [`A scene from chapter ${chapterNumber}: "${chapterTitle}" of this ${storyContext.story.novelStyle || 'adventure'} story.`];
  }
}

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
  chapterCount: z.number().int().positive().optional(),
  outline: z.object({
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

// Type definitions
const OutlineSchema = z.object({
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
});

type OutlineData = z.infer<typeof OutlineSchema>;

// Helper function to check if data matches outline structure
function isOutlineData(data: unknown): data is OutlineData {
  try {
    OutlineSchema.parse(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /ai/text/outline
 * Generate story outline using AI text generation with story context from database
 */
router.post('/text/outline', async (req, res) => {  try {
    const { storyId, runId } = OutlineRequestSchema.parse(req.body);

    // Load story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: `Story not found: ${storyId}`
      });
      return;
    }    // Load prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-outline');    // Use the chapterCount from the database, fallback to 6 if not available
    const chapterCount = storyContext.story.chapterCount || 6;

    // Prepare template variables
    const templateVars = {
      novelStyle: storyContext.story.novelStyle || 'adventure',
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      place: storyContext.story.place || 'a magical land',
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount,      characters: JSON.stringify(
        storyContext.characters.map(char => ({
          name: char.name,
          type: char.type || '',
          role: char.role || '',
          age: char.age || '',
          traits: char.traits || [],
          characteristics: char.characteristics || '',
          physicalDescription: char.physicalDescription || ''
        })),
        null,
        2
      ),
      bookTitle: storyContext.story.title,
      storyDescription: storyContext.story.plotDescription || storyContext.story.synopsis || 'No description provided',
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
    const storyOutlineSchema = await SchemaService.loadSchema('story-outline');    // Generate outline using AI with specific outline model and JSON schema
    // Use model based on configured text provider
    let outlineModel: string;
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
    
    if (textProvider === 'openai') {
      outlineModel = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1';
    } else if (textProvider === 'google-genai') {
      outlineModel = process.env.GOOGLE_GENAI_MODEL || 'gemini-2.5-flash';
    } else {
      outlineModel = 'gpt-4.1';
    }
    const requestOptions = {
      maxTokens: 16384,
      temperature: 1,
      model: outlineModel,
      jsonSchema: storyOutlineSchema
    };    // Create context for token tracking
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'story_outline' as const
    };

    const outline = await aiGateway.getTextService(aiContext).complete(finalPrompt, requestOptions);

    // Parse and validate the AI response
    const parsedData = parseAIResponse(outline);
    
    // Validate that the response matches our expected structure
    if (!isOutlineData(parsedData)) {
      // Type guard failed, so we know parsedData doesn't match OutlineData
      // But we can still safely check basic properties for debugging
      const dataAsRecord = parsedData && typeof parsedData === 'object' ? parsedData as Record<string, unknown> : {};
      logger.error('Invalid outline structure', {
        hasBookTitle: !!(dataAsRecord?.bookTitle),
        hasChapters: !!(dataAsRecord?.chapters),
        isChaptersArray: Array.isArray(dataAsRecord?.chapters),
        actualKeys: Object.keys(dataAsRecord)
      });
      throw new Error('Invalid outline structure received');
    }
    
    const outlineData = parsedData;

    res.json({
      success: true,
      storyId,
      runId,
      outline: outlineData,
      storyContext: {
        title: storyContext.story.title,
        charactersCount: storyContext.characters.length
      }    });
  } catch (error) {
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
        return;      }
    }

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

    // Create context for token tracking
    const chapterContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'chapter_writing' as const
    };

    // Generate chapter content
    const chapterText = await aiGateway.getTextService(chapterContext).complete(chapterPrompt, {
      maxTokens: 16384,
      temperature: 1
    });

    // Generate image prompts based on the chapter content
    const imagePrompts = await generateImagePromptsForChapter(
      chapterText,
      storyContext,
      chapterNumber,
      chapterTitle,
      chapterContext
    );

    res.json({
      success: true,
      storyId,
      runId: runId || null,
      chapterNumber,
      chapter: chapterText.trim(),
      imagePrompts
    });
  } catch (error) {
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

    // Get story context to extract authorId for token tracking
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // Create context for token tracking
    const imageContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'image_generation' as const
    };

    // Set default dimensions using environment configuration
    let imageWidth = width;
    let imageHeight = height;
    
    if (!imageWidth && !imageHeight) {
      const dimensions = getImageDimensions(imageType);
      imageWidth = dimensions.width;
      imageHeight = dimensions.height;
    }

    currentStep = 'generating_image';
    const imageBuffer = await aiGateway.getImageService(imageContext).generate(prompt, {
      ...(imageWidth && { width: imageWidth }),
      ...(imageHeight && { height: imageHeight }),
      ...(style && { style }),
      bookTitle: storyContext.story.title,
      ...(storyContext.story.graphicalStyle && { graphicalStyle: storyContext.story.graphicalStyle }),
      ...(imageType && { imageType })
    });

    currentStep = 'preparing_upload';
    const filename = generateImageFilename({
      storyId,
      ...(imageType ? { imageType } : {}),
      ...(chapterNumber !== undefined ? { chapterNumber } : {})
    });    currentStep = 'uploading_to_storage';
    const imageUrl = await storageService.uploadFile(filename, imageBuffer, 'image/jpeg');

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      image: {
        url: imageUrl,
        filename,
        format: 'jpeg',
        size: imageBuffer.length
      }
    });} catch (error) {
    const errorDetails = formatImageError(error, req.body, currentStep);

    res.status(500).json({
      success: false,
      error: errorDetails.message,
      failedAt: currentStep,
      timestamp: errorDetails.timestamp,
      requestId: req.body.runId || 'unknown'
    });
  }
});

/**
 * GET /ai/test-text
 * Test the configured text AI provider with environment variables and basic prompt
 */
router.get('/test-text', async (_req, res) => {
  try {    // Collect relevant environment variables for AI provider selection
    const envVars = {
      TEXT_PROVIDER: process.env.TEXT_PROVIDER,
      IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,
      
      // Google GenAI
      GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY ? '***REDACTED***' : undefined,
      GOOGLE_GENAI_MODEL: process.env.GOOGLE_GENAI_MODEL,
      
      // OpenAI
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***REDACTED***' : undefined,
      OPENAI_TEXT_MODEL: process.env.OPENAI_TEXT_MODEL,
      
      // Debug settings
      DEBUG_AI_FULL_PROMPTS: process.env.DEBUG_AI_FULL_PROMPTS,
      DEBUG_AI_FULL_RESPONSES: process.env.DEBUG_AI_FULL_RESPONSES,
      LOG_LEVEL: process.env.LOG_LEVEL
    };
    
    // Create a test context for the AI call
    const testContext = {
      authorId: '00000000-0000-0000-0000-000000000001', // Test UUID
      storyId: '00000000-0000-0000-0000-000000000002', // Test UUID
      action: 'test' as const
    };

    let success = false;
    let response = '';
    let error = null;
    let provider = '';
    
    try {
      // Get the text service from the AI gateway
      const textService = aiGateway.getTextService(testContext);
      provider = process.env.TEXT_PROVIDER || 'google-genai';
      
      // Make a basic prompt request
      response = await textService.complete('Say hi and tell me you are working correctly. Keep it brief.', {
        maxTokens: 100,
        temperature: 0.7
      });
      
      success = true;
    } catch (aiError) {
      success = false;
      error = {
        message: aiError instanceof Error ? aiError.message : String(aiError),
        stack: aiError instanceof Error ? aiError.stack : undefined,
        name: aiError instanceof Error ? aiError.name : 'UnknownError'
      };
    }

    res.json({
      success,
      timestamp: new Date().toISOString(),
      environment: envVars,
      testResult: {
        provider,
        response: success ? response : null,
        error: error
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : 'UnknownError'
      }
    });
  }
});

export { router as aiRouter };
