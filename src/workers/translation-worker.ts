/**
 * Translation Worker
 * Processes async translation jobs by translating all chapters (title + HTML)
 * and, upon full success, updates storyLanguage and selected metadata fields.
 */

import { logger } from '@/config/logger.js';
import { jobManager } from '@/services/job-manager.js';
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { PromptService } from '@/services/prompt.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';

const storyService = new StoryService();
const chaptersService = new ChaptersService();
const aiGateway = getAIGatewayWithTokenTracking();

export interface TranslateJobParams {
  storyId: string;
  targetLocale: string; // e.g., 'pt-PT'
}

/**
 * Process a translation job asynchronously
 */
export async function processTranslationJob(jobId: string, params: TranslateJobParams): Promise<void> {
  try {
    logger.info('Starting translation job processing', { jobId, params });

    const { storyId, targetLocale } = params;

    // Update job status to processing
    jobManager.updateJobStatus(jobId, 'processing');

    // Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    // Load latest chapters
    const storyChapters = await chaptersService.getStoryChapters(storyId);
    if (storyChapters.length === 0) {
      throw new Error('No chapters found for this story');
    }

    const aiContext = {
      authorId: story.authorId,
      storyId: story.storyId,
      action: 'story_enhancement' as const
    };

    const updatedChapters: Array<{
      chapterNumber: number;
      titleTranslated?: string;
      htmlLengthBefore?: number;
      htmlLengthAfter?: number;
      error?: string;
    }> = [];

    // Translate chapter by chapter
    for (const chapter of storyChapters) {
      const chapterResult: any = { chapterNumber: chapter.chapterNumber };
      try {
        // Translate title (plain text)
        const titlePrompt = await buildTranslatePrompt(targetLocale, {
          contentType: 'title',
          originalText: chapter.title,
          storyTitle: story.title
        });
        const translatedTitleRaw = await aiGateway.getTextService(aiContext).complete(titlePrompt, {
          maxTokens: 2048,
          temperature: 0.2
        });
        const translatedTitle = cleanAITextOutput(translatedTitleRaw);

        // Translate HTML content preserving structure
        const htmlPrompt = await buildTranslatePrompt(targetLocale, {
          contentType: 'html',
          originalText: chapter.htmlContent,
          storyTitle: story.title
        });
        const translatedHtmlRaw = await aiGateway.getTextService(aiContext).complete(htmlPrompt, {
          maxTokens: 16384,
          temperature: 0.2
        });
        const translatedHtml = cleanAITextOutput(translatedHtmlRaw);

        // Persist new chapter version
        const chapterData: any = {
          storyId: story.storyId,
          authorId: story.authorId,
          chapterNumber: chapter.chapterNumber,
          title: translatedTitle,
          htmlContent: translatedHtml,
        };
        if (chapter.imageUri) chapterData.imageUri = chapter.imageUri;
        if (chapter.audioUri) chapterData.audioUri = chapter.audioUri;
        await chaptersService.saveChapter(chapterData);

        chapterResult.titleTranslated = translatedTitle;
        chapterResult.htmlLengthBefore = chapter.htmlContent?.length ?? 0;
        chapterResult.htmlLengthAfter = translatedHtml.length;
        logger.info('Chapter translated successfully', {
          storyId: story.storyId,
          chapterNumber: chapter.chapterNumber,
          titleBefore: chapter.title,
          titleAfter: translatedTitle,
          originalLength: chapterResult.htmlLengthBefore,
          translatedLength: chapterResult.htmlLengthAfter
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chapterResult.error = msg;
        logger.error('Chapter translation failed', {
          storyId: story.storyId,
          chapterNumber: chapter.chapterNumber,
          error: msg
        });
      }
      updatedChapters.push(chapterResult);
    }

    // Determine success
    const failed = updatedChapters.filter(ch => ch.error).length;
    let metaUpdate: { title?: string; synopsis?: string; plotDescription?: string } | undefined;

    // Only update storyLanguage and metadata if all chapters succeeded
    if (failed === 0) {
      // Translate title, synopsis and plotDescription if present
      metaUpdate = {};
      try {
        if (story.title) {
          const titlePrompt = await buildTranslatePrompt(targetLocale, {
            contentType: 'title',
            originalText: story.title,
            storyTitle: story.title
          });
          const titleTranslated = cleanAITextOutput(
            await aiGateway.getTextService(aiContext).complete(titlePrompt, { maxTokens: 512, temperature: 0.2 })
          );
          metaUpdate.title = titleTranslated;
        }

        if (story.synopsis) {
          const synopsisPrompt = await buildTranslatePrompt(targetLocale, {
            contentType: 'text',
            originalText: story.synopsis,
            storyTitle: story.title
          });
          const synopsisTranslated = cleanAITextOutput(
            await aiGateway.getTextService(aiContext).complete(synopsisPrompt, { maxTokens: 4096, temperature: 0.2 })
          );
          metaUpdate.synopsis = synopsisTranslated;
        }

        if (story.plotDescription) {
          const plotPrompt = await buildTranslatePrompt(targetLocale, {
            contentType: 'text',
            originalText: story.plotDescription,
            storyTitle: story.title
          });
          const plotTranslated = cleanAITextOutput(
            await aiGateway.getTextService(aiContext).complete(plotPrompt, { maxTokens: 4096, temperature: 0.2 })
          );
          metaUpdate.plotDescription = plotTranslated;
        }
      } catch (metaErr) {
        logger.warn('Metadata translation encountered an issue; proceeding without updating some metadata fields', {
          storyId: story.storyId,
          error: metaErr instanceof Error ? metaErr.message : String(metaErr)
        });
      }

      try {
        const updates: any = { storyLanguage: targetLocale };
        if (metaUpdate?.title) updates.title = metaUpdate.title;
        if (metaUpdate?.synopsis) updates.synopsis = metaUpdate.synopsis;
        if (metaUpdate?.plotDescription) updates.plotDescription = metaUpdate.plotDescription;
        await storyService.updateStoryLanguageAndTexts(story.storyId, updates);
        logger.info('Story language updated after successful translation', {
          storyId: story.storyId,
          targetLocale
        });
      } catch (updErr) {
        logger.error('Failed to update story language after translation', {
          storyId: story.storyId,
          error: updErr instanceof Error ? updErr.message : String(updErr)
        });
      }
    }

    const result = {
      success: failed === 0,
      type: 'full_story_translation' as const,
      storyId: story.storyId,
      targetLocale,
      updatedChapters,
      totalChapters: storyChapters.length,
      successfulTranslations: updatedChapters.filter(ch => !ch.error).length,
      failedTranslations: failed,
      metadataUpdated: failed === 0,
      timestamp: new Date().toISOString()
    };

    jobManager.updateJobStatus(jobId, 'completed', result);

    logger.info('Translation job completed', {
      jobId,
      storyId: story.storyId,
      targetLocale,
      failed
    });
  } catch (error) {
    logger.error('Translation job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error)
    });

    jobManager.updateJobStatus(jobId, 'failed', undefined,
      error instanceof Error ? error.message : 'Translation failed'
    );
  }
}

async function buildTranslatePrompt(
  targetLocale: string,
  opts: { contentType: 'html' | 'text' | 'title'; originalText: string; storyTitle?: string }
): Promise<string> {
  const { contentType, originalText, storyTitle } = opts;
  const promptTemplate = await PromptService.loadPrompt(targetLocale, 'translate');

  const variables = {
    // content type flags for conditional blocks in template
    isHtml: contentType === 'html' ? 'true' : '',
    isTitle: contentType === 'title' ? 'true' : '',
    isText: contentType === 'text' ? 'true' : '',
    originalText,
    targetLocale,
    storyTitle: storyTitle ?? ''
  } as const;

  return PromptService.buildPrompt(promptTemplate, variables as unknown as Record<string, unknown>);
}

function cleanAITextOutput(output: string): string {
  let text = output?.trim() ?? '';
  // strip markdown code fences if present
  if (text.startsWith('```')) {
    const match = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    if (match && match[1]) {
      text = match[1].trim();
    } else {
      text = text.replace(/^```[\s\S]*?```$/g, '').trim();
    }
  }
  return text;
}
