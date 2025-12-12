// -----------------------------------------------------------------------------
// Shared Utilities - Environment-agnostic utility functions
// -----------------------------------------------------------------------------

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export function estimateReadingTime(wordCount: number, wordsPerMinute: number = 200): number {
  return Math.ceil(wordCount / wordsPerMinute);
}

export function validateImagePrompt(prompt: string): boolean {
  return prompt.length >= 10 && prompt.length <= 1000;
}

export function sanitizeHtml(html: string): string {
  // Basic HTML sanitization - in production, use a proper library like DOMPurify
  return html
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
    .replace(/javascript:/gi, '');
}

export function formatFileSize(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
): Promise<T> {
  let lastError: Error = new Error('Retry function failed');

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error as Error;

      if (i === maxRetries) {
        throw lastError;
      }

      await delay(delayMs * Math.pow(2, i)); // Exponential backoff
    }
  }

  // This should never be reached, but TypeScript requires it
  throw lastError;
}

// -----------------------------------------------------------------------------
// Story Generation Utilities
// ----------------------------------------------------------------------------->

export interface StoryCharacter {
  characterId?: string | undefined;
  name: string;
  type?: string | undefined;
  role?: string | undefined;
  age?: string | undefined;
  traits?: string[] | undefined;
  characteristics?: string | undefined;
  physicalDescription?: string | undefined;
}

export interface StoryContext {
  story: {
    title: string;
    targetAudience?: string;
    novelStyle?: string;
    place?: string;
    storyLanguage: string;
    plotDescription?: string;
    synopsis?: string;
    additionalRequests?: string;
    graphicalStyle?: string;
    chapterCount?: number;
  };
  characters: StoryCharacter[];
}

/**
 * Converts language code to human-readable name
 */
export function getLanguageName(languageCode: string): string {
  const languageMap: Record<string, string> = {
    'en-US': 'English (American)',
    'en-GB': 'English (British)',
    'pt-PT': 'Portuguese from Portugal',
    'pt-BR': 'Portuguese from Brazil',
    'es-ES': 'Spanish from Spain',
    'es-MX': 'Spanish from Mexico',
    'fr-FR': 'French from France',
    'fr-CA': 'French from Canada',
    'de-DE': 'German from Germany',
    'de-AT': 'German from Austria',
    'it-IT': 'Italian from Italy',
    'nl-NL': 'Dutch from Netherlands',
    'pl-PL': 'Polish from Poland',
    'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)',
    'ja-JP': 'Japanese from Japan',
    'ko-KR': 'Korean from South Korea',
    'ru-RU': 'Russian from Russia',
    'ar-SA': 'Arabic from Saudi Arabia',
  };

  return languageMap[languageCode] || 'English';
}

/**
 * Prepares characters for prompt (removing IDs to reduce tokens)
 */
export function prepareCharactersForPrompt(characters: StoryCharacter[]): string {
  const charactersWithoutIds = characters.map((char) => ({
    characterId: char.characterId,
    name: char.name,
    type: char.type,
    role: char.role,
    age: char.age,
    traits: char.traits,
    characteristics: char.characteristics,
    physicalDescription: char.physicalDescription,
  }));

  return JSON.stringify(charactersWithoutIds, null, 2);
}

/**
 * Formats target audience for better prompting
 */
export function formatTargetAudience(targetAudience?: string): string {
  if (!targetAudience) return 'children ages 7-10';

  const audienceMap: Record<string, string> = {
    'children_0-2': 'babies and toddlers (0-2 years)',
    'children_3-6': 'preschoolers (3-6 years)',
    'children_7-10': 'early elementary children (7-10 years)',
    'children_11-14': 'middle grade children (11-14 years)',
    'young_adult_15-17': 'young adults (15-17 years)',
    'adult_18+': 'adults (18+ years)',
    all_ages: 'readers of all ages',
  };

  return audienceMap[targetAudience] || 'children ages 7-10';
}

/**
 * Extracts target age category from targetAudience for audio prompt configuration
 */
export function extractTargetAge(targetAudience?: string | null): string | undefined {
  if (!targetAudience) return undefined;

  // Map target audience enum values to audio prompt target age categories
  const ageMap: Record<string, string> = {
    'children_0-2': 'toddlers',
    'children_3-6': 'children',
    'children_7-10': 'children',
    'children_11-14': 'children',
    'young_adult_15-17': 'young adults',
    'adult_18+': 'adults',
    all_ages: 'general audience',
  };

  return ageMap[targetAudience];
}

/**
 * Generates story description from story context
 */
export function getStoryDescription(storyContext: StoryContext): string {
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
 * Parses AI response, handling various formats including markdown code blocks
 */
export function parseAIResponse(response: string): unknown {
  let cleanedResponse = response.trim();

  // Handle markdown code blocks
  if (response.includes('```json')) {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      cleanedResponse = jsonMatch[1].trim();
    }
  } else if (response.includes('```')) {
    // Remove any code blocks that aren't JSON and try to extract JSON content
    const withoutCodeBlocks = response.replace(/```[^`]*```/g, '').trim();
    const startIndex = withoutCodeBlocks.indexOf('{');
    const lastIndex = withoutCodeBlocks.lastIndexOf('}');
    if (startIndex !== -1 && lastIndex !== -1 && lastIndex > startIndex) {
      cleanedResponse = withoutCodeBlocks.substring(startIndex, lastIndex + 1);
    }
  } else if (response.trim().startsWith('```') && response.trim().endsWith('```')) {
    // Handle case where entire response is wrapped in code blocks without language
    cleanedResponse = response.replace(/^```[\s\S]*?```$/, '').trim();
  }

  // Extract JSON if response contains other text
  if (!cleanedResponse.startsWith('{') && !cleanedResponse.startsWith('[')) {
    const startIndex = cleanedResponse.indexOf('{');
    const lastIndex = cleanedResponse.lastIndexOf('}');
    if (startIndex !== -1 && lastIndex !== -1 && lastIndex > startIndex) {
      cleanedResponse = cleanedResponse.substring(startIndex, lastIndex + 1);
    }
  }

  const extractFirstJsonBlock = (input: string): string | null => {
    let startIndex = -1;
    const stack: string[] = [];
    let inString = false;
    let escaping = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === '\\') {
          escaping = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        if (stack.length === 0) {
          startIndex = i;
        }
        stack.push(char === '{' ? '}' : ']');
        continue;
      }

      if ((char === '}' || char === ']') && stack.length > 0) {
        const expected = stack.pop();
        if ((char === '}' && expected !== '}') || (char === ']' && expected !== ']')) {
          // Mismatched braces, reset and continue searching
          stack.length = 0;
          startIndex = -1;
          continue;
        }
        if (stack.length === 0 && startIndex !== -1) {
          return input.slice(startIndex, i + 1);
        }
      }
    }

    return null;
  };

  try {
    return JSON.parse(cleanedResponse);
  } catch (primaryError) {
    const fallbackJson = extractFirstJsonBlock(cleanedResponse);
    if (fallbackJson) {
      return JSON.parse(fallbackJson);
    }
    throw primaryError;
  }
}
