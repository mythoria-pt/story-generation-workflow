/**
 * Image Utilities
 * Helper functions for image processing, URL parsing, and configuration
 */

import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';

/**
 * Extract filename from Google Storage URI
 * @param uri - Google Storage URI (gs://bucket/filename or https://storage.googleapis.com/bucket/filename)
 * @returns filename with full path including folder structure
 */
export function extractFilenameFromUri(uri: string): string {
  try {
    // Handle both gs:// and https:// formats
    if (uri.startsWith('gs://')) {
      const parts = uri.replace('gs://', '').split('/');
      return parts.slice(1).join('/'); // Remove bucket name, keep path
    } else if (uri.includes('storage.googleapis.com')) {
      const url = new URL(uri);
      const pathParts = url.pathname.split('/');
      return pathParts.slice(2).join('/'); // Remove empty string and bucket name
    } else {
      // Fallback: treat as relative path
      return uri;
    }
  } catch (error) {
    logger.warn('Failed to extract filename from URI, using fallback', {
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return uri;
  }
}

/**
 * Get image dimensions based on image type and environment configuration
 * @param imageType - Type of image (front_cover, back_cover, chapter, or default)
 * @returns Object with width and height
 */
export function getImageDimensions(imageType?: string): { width: number; height: number } {
  const env = getEnvironment();

  switch (imageType) {
    case 'front_cover':
    case 'back_cover':
      return {
        width: env.IMAGE_COVER_WIDTH,
        height: env.IMAGE_COVER_HEIGHT,
      };
    case 'chapter':
      return {
        width: env.IMAGE_CHAPTER_WIDTH,
        height: env.IMAGE_CHAPTER_HEIGHT,
      };
    default:
      return {
        width: env.IMAGE_DEFAULT_WIDTH,
        height: env.IMAGE_DEFAULT_HEIGHT,
      };
  }
}

/**
 * Generate next version filename for an image
 * @param currentUri - Current image URI
 * @returns New filename with incremented version
 */
export function generateNextVersionFilename(currentUri: string): string {
  // Extract filename and increment version
  // Example: frontcover_v001.jpg -> frontcover_v002.jpg
  const versionRegex = /_v(\d{3})\./;
  const match = currentUri.match(versionRegex);

  if (match && match[1]) {
    const currentVersion = parseInt(match[1]);
    const nextVersion = currentVersion + 1;
    const nextVersionStr = nextVersion.toString().padStart(3, '0');
    return currentUri.replace(versionRegex, `_v${nextVersionStr}.`);
  }

  // Fallback: add v002 if no version found
  const extensionRegex = /(\.[^.]+)$/;
  return currentUri.replace(extensionRegex, '_v002$1');
}

/**
 * Convert relative image path to absolute URL
 * @param imagePath - Image path (can be relative starting with / or absolute with http)
 * @returns Absolute URL for the image
 */
export function convertToAbsoluteImagePath(imagePath: string): string {
  // If already absolute (starts with http), return as-is
  if (imagePath.startsWith('http')) {
    return imagePath;
  }

  // If relative path (starts with /), prepend the domain
  if (imagePath.startsWith('/')) {
    return `https://storage.googleapis.com/mythoria-generated-stories${imagePath}`;
  }

  // If no leading slash, add it and prepend domain
  return `https://storage.googleapis.com/mythoria-generated-stories/${imagePath}`;
}

/**
 * Sanitise a story title for embedding inside a quoted prompt instruction.
 * Trims, collapses whitespace and replaces straight double quotes with typographic quotes.
 * @param title - Raw story title
 * @returns Sanitised title (empty string when nothing usable remains)
 */
export function sanitizeBookTitleForPrompt(title: string | undefined | null): string {
  if (!title) return '';
  const collapsed = title.replace(/\s+/g, ' ').trim();
  let open = true;
  return collapsed.replace(/"/g, () => {
    const quote = open ? '“' : '”';
    open = !open;
    return quote;
  });
}

/**
 * Build the explicit title-lettering request appended to a front-cover edit request.
 * @param title - Story title (sanitised internally)
 * @returns One-line request, or an empty string when the title is empty
 */
export function buildCoverTitleRequest(title: string | undefined | null): string {
  const safe = sanitizeBookTitleForPrompt(title);
  if (!safe) return '';
  return `Letter the exact book title "${safe}" on the cover, in the top third.`;
}

/**
 * Build the system-level instruction that makes the cover title a hard requirement.
 * @param title - Story title (sanitised internally)
 * @returns System instruction, or an empty string when the title is empty
 */
export function buildCoverTitleSystemPrompt(title: string | undefined | null): string {
  const safe = sanitizeBookTitleForPrompt(title);
  if (!safe) return '';
  return `You are illustrating the front cover of a children's book titled "${safe}". The cover must show this exact title, spelled exactly as written, hand-lettered in a style that matches the illustration, large and legible, in the top third of the image. The title is the only text on the cover.`;
}

/**
 * Build image editing prompt with proper structure and style integration
 * @param userRequest - User's editing request
 * @param graphicalStyle - Style from imageStyles.json
 * @param styleKeywords - Style-specific keywords from PromptService
 * @param hasReferenceImage - Whether an extra reference image accompanies the base image
 * @param fullStyleSystemPrompt - Full style system prompt from PromptService
 * @param bookTitle - Story title. Only pass for front covers: when non-empty, the prompt
 *   instructs the model to keep/letter the exact title. Omit for back covers and chapters,
 *   which must stay text-free.
 * @returns Structured prompt for image editing
 */
export function buildImageEditPrompt(
  userRequest: string,
  graphicalStyle?: string,
  styleKeywords?: string,
  hasReferenceImage?: boolean,
  fullStyleSystemPrompt?: string,
  bookTitle?: string,
): string {
  const title = sanitizeBookTitleForPrompt(bookTitle);
  const titleRequest = buildCoverTitleRequest(title);
  const requestBody =
    userRequest || 'Refine and stylistically adapt the image without altering its core subjects.';
  let prompt = `You are transforming an existing story illustration while preserving core subject identity, spatial composition, narrative continuity and essential lighting. Apply only the requested changes unless they conflict with style directives.\n\n<edit_request>\n${titleRequest ? `${requestBody}\n${titleRequest}` : requestBody}\n</edit_request>`;

  if (hasReferenceImage) {
    prompt += `\n\n<reference_image_usage>Leverage the provided reference image strictly to maintain subject identity, proportions, relative positioning, palette relationships and overall composition. Do NOT remove primary subjects unless explicitly asked. Preserve camera angle where plausible.</reference_image_usage>`;
  } else {
    prompt += `\n\n<original_preservation>Preserve recognizable subjects and scene layout from the supplied base image.</original_preservation>`;
  }

  if (fullStyleSystemPrompt) {
    prompt += `\n\n<target_style_full>\n${fullStyleSystemPrompt}\n</target_style_full>`;
  }

  if (styleKeywords || graphicalStyle) {
    prompt += `\n\n<style_keywords>${styleKeywords || graphicalStyle}</style_keywords>`;
  }

  if (title) {
    prompt += `

<title_lettering>
The cover shows the exact title "${title}", spelled exactly as written. It is hand-lettered in a style that matches the illustration style and palette, large and highly legible against its background, and placed in the top third of the image with a comfortable margin from the top edge. If the base image already shows this title, keep it legible and unchanged; otherwise add it. The title is the only text in the image; do not add any other text. Even if the edit request asks otherwise, the title must remain.
</title_lettering>`;
  }

  const textRule = title
    ? 'No other text, captions or watermarks besides the title.'
    : 'No text overlays or watermarks.';
  prompt += `

<quality_constraints>High fidelity, coherent anatomy, consistent lighting continuity, avoid introducing new major characters unless required. ${textRule}</quality_constraints>`;

  prompt += `\n\n<output_goal>Produce a SINGLE high-quality image matching the transformed description and style.</output_goal>`;
  return prompt;
}
