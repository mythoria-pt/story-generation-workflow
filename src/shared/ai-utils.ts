/**
 * AI Operation Utilities
 * Helper functions for AI request preparation and response handling
 */

import { logger } from '@/config/logger.js';
import { 
  StoryContext, 
  getChapterCountForAudience, 
  formatTargetAudience, 
  getLanguageName, 
  prepareCharactersForPrompt, 
  getStoryDescription,
  parseAIResponse
} from '@/shared/utils.js';

export interface OutlineTemplateVars {
  novelStyle: string;
  targetAudience: string;
  place: string;
  language: string;
  chapterCount: number;
  characters: string;
  bookTitle: string;
  storyDescription: string;
  description: string;
  graphicalStyle: string;
  bookCoverPrompt: string;
  bookBackCoverPrompt: string;
  synopses: string;
  chapterNumber: string;
  chapterPhotoPrompt: string;
  chapterTitle: string;
  chapterSynopses: string;
}

export interface ChapterTemplateVars {
  chapterNumber: string;
  chapterTitle: string;
  novelStyle: string;
  averageAge: string;
  description: string;
  chapterSynopses: string;
  language: string;
  chapterCount: string;
  hookInstruction: string;
}

/**
 * Prepares template variables for story outline generation
 */
export function prepareOutlineTemplateVars(storyContext: StoryContext): OutlineTemplateVars {
  const chapterCount = getChapterCountForAudience(storyContext.story.targetAudience);
  
  return {
    novelStyle: storyContext.story.novelStyle || 'adventure',
    targetAudience: formatTargetAudience(storyContext.story.targetAudience),
    place: storyContext.story.place || 'a magical land',
    language: getLanguageName(storyContext.story.storyLanguage),
    chapterCount,
    characters: prepareCharactersForPrompt(storyContext.characters),
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
}

/**
 * Prepares template variables for chapter generation
 */
export function prepareChapterTemplateVars(
  storyContext: StoryContext,
  chapterNumber: number,
  chapterTitle: string,
  chapterSynopses: string,
  chapterCount?: number
): ChapterTemplateVars {
  const hookInstruction = chapterCount && chapterNumber < chapterCount 
    ? 'If relevant, you may end with a hook for the next chapter.'
    : '';

  return {
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
}

/**
 * Validates outline structure
 */
export function validateOutlineStructure(outlineData: any): boolean {
  return !!(
    outlineData.bookTitle && 
    outlineData.chapters && 
    Array.isArray(outlineData.chapters)
  );
}

/**
 * Handles AI response parsing with error handling
 */
export async function handleAIResponse(
  response: string,
  storyId: string,
  runId: string,
  validateFn?: (data: any) => boolean
): Promise<any> {
  try {
    const parsedData = parseAIResponse(response);
    
    if (validateFn && !validateFn(parsedData)) {
      throw new Error('Invalid response structure received');
    }
    
    return parsedData;
  } catch (error) {
    logger.error('Failed to parse AI response', {
      error: error instanceof Error ? error.message : String(error),
      storyId,
      runId,
      responsePreview: response.substring(0, 500)
    });
    throw new Error('AI generated invalid response');
  }
}

/**
 * Gets AI model configuration
 */
export function getAIModelConfig(modelType: 'outline' | 'chapter' | 'image' = 'outline') {
  const configs = {
    outline: {
      model: process.env.VERTEX_AI_OUTLINE_MODEL || process.env.VERTEX_AI_MODEL_ID || 'gemini-2.0-flash',
      maxTokens: 8192,
      temperature: 1
    },
    chapter: {
      model: process.env.VERTEX_AI_MODEL_ID || 'gemini-2.0-flash',
      maxTokens: 6000,
      temperature: 0.8
    },
    image: {
      model: process.env.VERTEX_AI_IMAGE_MODEL || 'imagen-3.0-generate-001',
      maxTokens: 4096,
      temperature: 0.7
    }
  };
  
  return configs[modelType];
}
