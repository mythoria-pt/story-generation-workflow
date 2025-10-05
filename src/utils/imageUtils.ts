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
 * Build image editing prompt with proper structure and style integration
 * @param userRequest - User's editing request
 * @param graphicalStyle - Style from imageStyles.json
 * @param stylePrompt - Style-specific prompt from PromptService
 * @returns Structured prompt for image editing
 */
export function buildImageEditPrompt(
  userRequest: string,
  graphicalStyle?: string,
  styleKeywords?: string,
  hasReferenceImage?: boolean,
  fullStyleSystemPrompt?: string,
): string {
  let prompt = `You are transforming an existing story illustration while preserving core subject identity, spatial composition, narrative continuity and essential lighting. Apply only the requested changes unless they conflict with style directives.\n\n<edit_request>\n${userRequest || 'Refine and stylistically adapt the image without altering its core subjects.'}\n</edit_request>`;

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

  prompt += `\n\n<quality_constraints>High fidelity, coherent anatomy, consistent lighting continuity, avoid introducing new major characters unless required. No text overlays or watermarks.</quality_constraints>`;

  prompt += `\n\n<output_goal>Produce a SINGLE high-quality image matching the transformed description and style.</output_goal>`;
  return prompt;
}
