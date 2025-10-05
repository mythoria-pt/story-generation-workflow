/**
 * Text Edit Worker
 * Processes async text editing jobs by calling existing story-edit functionality
 */

import { logger } from '@/config/logger.js';
import { jobManager } from '@/services/job-manager.js';

// Import the existing story edit route logic
import { StoryService, StoryContext } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { PromptService } from '@/services/prompt.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { formatTargetAudience, getLanguageName } from '@/shared/utils.js';

// Initialize services
const storyService = new StoryService();
const chaptersService = new ChaptersService();
const aiGateway = getAIGatewayWithTokenTracking();

interface TextEditJobParams {
  storyId: string;
  userRequest: string;
  scope: 'chapter' | 'story';
  chapterNumber?: number;
}

/**
 * Process a text editing job asynchronously
 */
export async function processTextEditJob(jobId: string, params: TextEditJobParams): Promise<void> {
  try {
    logger.info('Starting text edit job processing', { jobId, params });

    const { storyId, userRequest, scope, chapterNumber } = params;

    // Update job status to processing
    jobManager.updateJobStatus(jobId, 'processing');

    // Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    let result: any;

    if (scope === 'chapter') {
      // Single chapter edit
      result = await processSingleChapterEdit(storyId, userRequest, chapterNumber);
    } else {
      // Full story edit
      result = await processFullStoryEdit(storyId, userRequest);
    }

    // Mark job as completed with result
    jobManager.updateJobStatus(jobId, 'completed', result);

    logger.info('Text edit job completed successfully', {
      jobId,
      storyId,
      scope,
      resultSize: JSON.stringify(result).length,
    });
  } catch (error) {
    logger.error('Text edit job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });

    jobManager.updateJobStatus(
      jobId,
      'failed',
      undefined,
      error instanceof Error ? error.message : 'Text editing failed',
    );
  }
}

/**
 * Process single chapter edit (extracted from existing story-edit.ts logic)
 */
async function processSingleChapterEdit(
  storyId: string,
  userRequest: string,
  chapterNumber?: number,
): Promise<any> {
  if (!chapterNumber) {
    throw new Error('Chapter number is required for single chapter edit');
  }

  // 1. Get the current chapter content from database
  const storyChapters = await chaptersService.getStoryChapters(storyId);
  const targetChapter = storyChapters.find((ch) => ch.chapterNumber === chapterNumber);

  if (!targetChapter) {
    throw new Error(`Chapter ${chapterNumber} not found`);
  }

  // 2. Load story context for AI prompt
  const storyContext = await storyService.getStoryContext(storyId);
  if (!storyContext) {
    throw new Error('Could not load story context');
  }

  // 3. Create AI prompt for chapter editing
  const editPrompt = await createChapterEditPrompt(
    targetChapter.htmlContent,
    userRequest,
    storyContext,
    chapterNumber,
    targetChapter.title,
  );

  // 4. Request changes from AI
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

  return {
    success: true,
    type: 'chapter_edit',
    storyId,
    chapterNumber,
    updatedHtml: editedContent.trim(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process full story edit (extracted from existing story-edit.ts logic)
 */
async function processFullStoryEdit(storyId: string, userRequest: string): Promise<any> {
  // 1. Get all chapters for the story
  const storyChapters = await chaptersService.getStoryChapters(storyId);

  if (storyChapters.length === 0) {
    throw new Error('No chapters found for this story');
  }

  // 2. Load story context for AI prompt
  const storyContext = await storyService.getStoryContext(storyId);
  if (!storyContext) {
    throw new Error('Could not load story context');
  }

  // 3. Edit each chapter using AI
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
        updatedHtml: editedContent.trim(),
        originalLength: chapter.htmlContent.length,
        editedLength: editedContent.length,
      });

      logger.info('Chapter edited successfully', {
        storyId,
        chapterNumber: chapter.chapterNumber,
        originalLength: chapter.htmlContent.length,
        editedLength: editedContent.length,
      });
    } catch (error) {
      logger.error('Failed to edit chapter', {
        storyId,
        chapterNumber: chapter.chapterNumber,
        error: error instanceof Error ? error.message : String(error),
      });

      editedChapters.push({
        chapterNumber: chapter.chapterNumber,
        error: error instanceof Error ? error.message : 'Chapter editing failed',
        originalLength: chapter.htmlContent.length,
        editedLength: 0,
      });
    }
  }

  return {
    success: true,
    type: 'full_story_edit',
    storyId,
    updatedChapters: editedChapters,
    totalChapters: storyChapters.length,
    successfulEdits: editedChapters.filter((ch) => !ch.error).length,
    failedEdits: editedChapters.filter((ch) => ch.error).length,
    timestamp: new Date().toISOString(),
  };
}

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
