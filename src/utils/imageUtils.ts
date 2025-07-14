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
      error: error instanceof Error ? error.message : String(error)
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
        height: env.IMAGE_COVER_HEIGHT
      };
    case 'chapter':
      return {
        width: env.IMAGE_CHAPTER_WIDTH,
        height: env.IMAGE_CHAPTER_HEIGHT
      };
    default:
      return {
        width: env.IMAGE_DEFAULT_WIDTH,
        height: env.IMAGE_DEFAULT_HEIGHT
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
 * Build image editing prompt with proper structure and style integration
 * @param userRequest - User's editing request
 * @param graphicalStyle - Style from imageStyles.json
 * @param stylePrompt - Style-specific prompt from PromptService
 * @returns Structured prompt for image editing
 */
export function buildImageEditPrompt(
  userRequest: string, 
  graphicalStyle?: string,
  stylePrompt?: string
): string {
  let prompt = 'Generate a new image, taking as basis the image in attach, but making the following changes: ';
  prompt += userRequest;

  if (stylePrompt) {
    prompt += `\n\nStyle: ${stylePrompt}`;
  } else if (graphicalStyle) {
    prompt += `\n\nStyle: ${graphicalStyle}`;
  }

  return prompt;
}
