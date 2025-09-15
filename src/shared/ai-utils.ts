/**
 * AI Operation Utilities
 * Helper functions for AI request preparation and response handling
 */

import { logger } from '@/config/logger.js';
import { 
  StoryContext, 
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
  // Use the chapterCount from the database, fallback to 6 if not available
  const chapterCount = storyContext.story.chapterCount || 6;
  
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
export function validateOutlineStructure(outlineData: unknown): boolean {
  return !!(
    outlineData && 
    typeof outlineData === 'object' &&
    'bookTitle' in outlineData && 
    'chapters' in outlineData && 
    Array.isArray((outlineData as { chapters: unknown }).chapters)
  );
}

/**
 * Handles AI response parsing with error handling
 */
export async function handleAIResponse(
  response: string,
  storyId: string,
  runId: string,
  validateFn?: (data: unknown) => boolean
): Promise<unknown> {
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
  // Unified on google-genai environment variables; legacy Vertex variables removed.
  const defaultTextModel = process.env.GOOGLE_GENAI_MODEL || 'gemini-2.5-flash';
  let defaultImageModel = process.env.GOOGLE_GENAI_IMAGE_MODEL || 'gemini-2.5-flash-image-preview';
  if (defaultImageModel.startsWith('imagen-')) {
    // Silent remap; upstream code logs during provider initialization
    defaultImageModel = 'gemini-2.5-flash-image-preview';
  }
  const configs = {
    outline: {
      model: defaultTextModel,
      temperature: 1
    },
    chapter: {
      model: defaultTextModel,
      temperature: 0.8
    },
    image: {
      model: defaultImageModel,
      temperature: 0.7
    }
  } as const;
  return configs[modelType];
}
