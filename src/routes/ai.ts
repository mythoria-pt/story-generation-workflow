/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { Router } from 'express';
import { AIGateway } from '../ai/gateway.js';
import { logger } from '@/config/logger.js';
import { z } from 'zod';

const router = Router();

// Initialize AI Gateway from environment
const aiGateway = AIGateway.fromEnvironment();

// Request schemas
const OutlineRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  prompt: z.string().min(1),
  genre: z.string().optional(),
  targetAudience: z.string().optional(),
  length: z.enum(['short', 'medium', 'long']).optional()
});

const ChapterRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  chapterNumber: z.number().int().positive(),
  outline: z.object({
    title: z.string(),
    characters: z.array(z.string()),
    setting: z.string(),
    plotPoints: z.array(z.string())
  }),
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
 * Generate story outline using AI text generation
 */
router.post('/text/outline', async (req, res) => {
  try {
    const { storyId, runId, prompt, genre, targetAudience, length } = OutlineRequestSchema.parse(req.body);

    logger.info('AI Gateway: Generating story outline', {
      storyId,
      runId,
      promptLength: prompt.length,
      genre,
      targetAudience,
      length
    });

    // Construct detailed outline prompt
    const detailedPrompt = `
Generate a detailed story outline for the following request:

Story Request: ${prompt}
${genre ? `Genre: ${genre}` : ''}
${targetAudience ? `Target Audience: ${targetAudience}` : ''}
${length ? `Story Length: ${length}` : ''}

Please provide a JSON response with the following structure:
{
  "title": "Story Title",
  "genre": "Genre",
  "targetAudience": "Target Audience",
  "synopsis": "Brief story synopsis (2-3 sentences)",
  "characters": [
    {
      "name": "Character Name",
      "role": "protagonist/antagonist/supporting",
      "description": "Brief character description"
    }
  ],
  "setting": {
    "location": "Where the story takes place",
    "timeframe": "When the story takes place",
    "atmosphere": "Mood and tone"
  },
  "chapters": [
    {
      "number": 1,
      "title": "Chapter Title",
      "summary": "Chapter summary",
      "keyEvents": ["Event 1", "Event 2"],
      "imagePrompt": "Description for illustration"
    }
  ],
  "themes": ["Theme 1", "Theme 2"],
  "estimatedWordCount": 1000
}

Ensure the outline is engaging, age-appropriate, and follows good storytelling structure.
`;

    const outline = await aiGateway.getTextService().complete(detailedPrompt, {
      maxTokens: 4096,
      temperature: 0.7
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
      outlineLength: outline.length
    });

    res.json({
      success: true,
      storyId,
      runId,
      outline: outlineData
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
 * POST /ai/text/chapter/:chapterNumber
 * Generate a specific chapter using AI text generation
 */
router.post('/text/chapter/:chapterNumber', async (req, res) => {
  try {
    const chapterNumber = parseInt(req.params.chapterNumber);
    const requestData = { ...req.body, chapterNumber };
    const { storyId, runId, outline, previousChapters } = ChapterRequestSchema.parse(requestData);

    logger.info('AI Gateway: Generating chapter', {
      storyId,
      runId,
      chapterNumber
    });

    // Construct chapter writing prompt
    const chapterPrompt = `
Write Chapter ${chapterNumber} of a story based on the following outline:

Title: ${outline.title}
Characters: ${outline.characters.join(', ')}
Setting: ${outline.setting}
Plot Points for this chapter: ${outline.plotPoints.join(', ')}

${previousChapters && previousChapters.length > 0 ? `
Previous chapters summary:
${previousChapters.map((ch, i) => `Chapter ${i + 1}: ${ch.substring(0, 200)}...`).join('\n')}
` : ''}

Please write an engaging chapter that:
1. Advances the story according to the outline
2. Develops the characters naturally
3. Maintains consistent tone and style
4. Includes vivid descriptions and dialogue
5. Ends with a natural transition or mild cliffhanger

At the end, also provide 2-3 image prompts for illustrations that would enhance this chapter.

Format your response as:
---CHAPTER---
[Chapter content here]

---IMAGE_PROMPTS---
1. [Image prompt 1]
2. [Image prompt 2]
3. [Image prompt 3]
`;

    const chapterText = await aiGateway.getTextService().complete(chapterPrompt, {
      maxTokens: 6000,
      temperature: 0.8
    });    // Parse chapter and image prompts
    const parts = chapterText.split('---IMAGE_PROMPTS---');
    const chapter = (parts[0] || chapterText).replace('---CHAPTER---', '').trim();
    const imagePrompts = parts[1] ? parts[1].trim().split('\n').filter(p => p.trim()) : [];

    logger.info('AI Gateway: Chapter generated successfully', {
      storyId,
      runId,
      chapterNumber,
      chapterLength: chapter.length,
      imagePromptsCount: imagePrompts.length
    });

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      chapter,
      imagePrompts
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
