/**
 * Story Edit API Routes
 * RESTful endpoints for editing existing published stories using AI
 * New database-driven approach using chapters table
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { StoryService, StoryContext } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { PromptService } from '@/services/prompt.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { formatTargetAudience, getLanguageName } from '@/shared/utils.js';

const router = Router();

// Initialize services
const storyService = new StoryService();
const chaptersService = new ChaptersService();
const aiGateway = getAIGatewayWithTokenTracking();

// Request schemas
const ChapterEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000),
});

const FullStoryEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000),
});

/**
 * PATCH /stories/:storyId/chapters/:chapterNumber
 * Edit a specific chapter of a story using AI
 */
router.patch('/stories/:storyId/chapters/:chapterNumber', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const chapterNumber = parseInt(req.params.chapterNumber);
    const { userRequest } = ChapterEditRequestSchema.parse(req.body);

    if (!storyId || isNaN(chapterNumber) || chapterNumber < 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid storyId or chapterNumber',
      });
      return;
    }

    logger.info('Chapter edit request received', {
      storyId,
      chapterNumber,
      userRequestLength: userRequest.length,
    });

    // 1. Load story metadata from database and confirm it exists
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    // 2. Get the current chapter content from database
    const storyChapters = await chaptersService.getStoryChapters(storyId);
    const targetChapter = storyChapters.find((ch) => ch.chapterNumber === chapterNumber);

    if (!targetChapter) {
      logger.warn('Chapter not found', { storyId, chapterNumber });
      res.status(404).json({
        success: false,
        error: `Chapter ${chapterNumber} not found`,
      });
      return;
    }

    // 3. Load story context for AI prompt
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context',
      });
      return;
    }

    // 4. Create AI prompt for chapter editing
    const editPrompt = await createChapterEditPrompt(
      targetChapter.htmlContent,
      userRequest,
      storyContext,
      chapterNumber,
      targetChapter.title,
    );

    logger.debug('Created chapter edit prompt', {
      storyId,
      chapterNumber,
      promptLength: editPrompt.length,
    });

    // 5. Request changes from AI
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'story_enhancement' as const,
    };

    const editedContent = await aiGateway.getTextService(aiContext).complete(editPrompt, {
      temperature: 0.7,
    });

    logger.info('AI chapter editing completed', {
      storyId,
      chapterNumber,
      originalLength: targetChapter.htmlContent.length,
      editedLength: editedContent.length,
    });

    // 6. Return the edited chapter content
    res.json({
      success: true,
      storyId,
      chapterNumber,
      editedContent: editedContent.trim(),
      metadata: {
        originalLength: targetChapter.htmlContent.length,
        editedLength: editedContent.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Chapter edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params?.storyId,
      chapterNumber: req.params?.chapterNumber,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Chapter editing failed',
    });
  }
});

/**
 * PATCH /stories/:storyId/chapters
 * Edit all chapters of a story using AI
 */
router.patch('/stories/:storyId/chapters', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const { userRequest } = FullStoryEditRequestSchema.parse(req.body);

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'Invalid storyId',
      });
      return;
    }

    logger.info('Full story edit request received', {
      storyId,
      userRequestLength: userRequest.length,
    });

    // 1. Load story metadata from database and confirm it exists
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    // 2. Get all chapters for the story
    const storyChapters = await chaptersService.getStoryChapters(storyId);

    if (storyChapters.length === 0) {
      logger.warn('No chapters found for story', { storyId });
      res.status(404).json({
        success: false,
        error: 'No chapters found for this story',
      });
      return;
    }

    // 3. Load story context for AI prompt
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context',
      });
      return;
    }

    // 4. Edit each chapter using AI
    const editedChapters = [];

    for (const chapter of storyChapters) {
      try {
        const editPrompt = await createChapterEditPrompt(
          chapter.htmlContent,
          userRequest,
          storyContext,
          chapter.chapterNumber,
          chapter.title,
        );

        const aiContext = {
          authorId: storyContext.story.authorId,
          storyId: storyId,
          action: 'story_enhancement' as const,
        };

        const editedContent = await aiGateway.getTextService(aiContext).complete(editPrompt, {
          temperature: 0.7,
        });

        editedChapters.push({
          chapterNumber: chapter.chapterNumber,
          editedContent: editedContent.trim(),
          originalLength: chapter.htmlContent.length,
          editedLength: editedContent.length,
        });

        logger.info('Chapter edited successfully', {
          storyId,
          chapterNumber: chapter.chapterNumber,
          originalLength: chapter.htmlContent.length,
          editedLength: editedContent.length,
        });
      } catch (chapterError) {
        logger.error('Failed to edit chapter', {
          error: chapterError instanceof Error ? chapterError.message : String(chapterError),
          storyId,
          chapterNumber: chapter.chapterNumber,
        });

        // Continue with other chapters but note the failure
        editedChapters.push({
          chapterNumber: chapter.chapterNumber,
          error: 'Failed to edit chapter',
          originalLength: chapter.htmlContent.length,
          editedLength: 0,
        });
      }
    }

    logger.info('Full story edit completed', {
      storyId,
      totalChapters: storyChapters.length,
      successfulEdits: editedChapters.filter((ch) => !ch.error).length,
    });

    // 5. Return all edited chapters
    res.json({
      success: true,
      storyId,
      editedChapters,
      metadata: {
        totalChapters: storyChapters.length,
        successfulEdits: editedChapters.filter((ch) => !ch.error).length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Full story edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params?.storyId,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Full story editing failed',
    });
  }
});

/**
 * Create AI prompt for editing a specific chapter
 */
async function createChapterEditPrompt(
  chapterContent: string,
  userRequest: string,
  storyContext: StoryContext,
  chapterNumber: number,
  chapterTitle: string,
): Promise<string> {
  try {
    // Load chapter edit prompt template
    const promptTemplate = await PromptService.loadPrompt('en-US', 'story-edit');

    // Prepare template variables
    const templateVars = {
      contextDescription: `Chapter ${chapterNumber}: ${chapterTitle}`,
      userRequest: userRequest,
      originalText: chapterContent,
      storyTitle: storyContext.story.title,
      novelStyle: storyContext.story.novelStyle || 'adventure',
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      language: getLanguageName(storyContext.story.storyLanguage),
      storySetting: storyContext.story.place || 'Unknown setting',
    };

    return PromptService.buildPrompt(promptTemplate, templateVars);
  } catch (error) {
    logger.error('Failed to create chapter edit prompt', {
      error: error instanceof Error ? error.message : String(error),
      chapterNumber,
      userRequest: userRequest.substring(0, 100),
    });

    // Fallback to simple prompt if template fails
    return `You are helping to edit a chapter of a story.

Story Title: ${storyContext.story.title}
Chapter ${chapterNumber}: ${chapterTitle}
Target Audience: ${formatTargetAudience(storyContext.story.targetAudience)}
Language: ${getLanguageName(storyContext.story.storyLanguage)}

Current Chapter Content:
${chapterContent}

User Request: ${userRequest}

Please edit the chapter content according to the user's request while maintaining the story's style, tone, and consistency. Return only the edited chapter content without any additional commentary.`;
  }
}

export { router as storyEditRouter };
