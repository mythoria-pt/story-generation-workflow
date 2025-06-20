/**
 * Image Edit API Routes
 * Endpoints for editing existing story images using AI
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';
import { StoryService } from '@/services/story.js';
import { StorageService } from '@/services/storage.js';
import { AIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Storage } from '@google-cloud/storage';

const router = Router();

// Initialize services
const storyService = new StoryService();
const storageService = new StorageService();
const aiGateway = AIGatewayWithTokenTracking.fromEnvironment();

// Get current directory for prompt file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Request schema
const ImageEditRequestSchema = z.object({
  storyId: z.string().uuid(),
  imageUrl: z.string().url().refine(url => url.startsWith('gs://') || url.startsWith('https://storage.googleapis.com/'), {
    message: "Image URL must be a Google Cloud Storage URL (gs:// or https://storage.googleapis.com/)"
  }),
  userRequest: z.string().min(1).max(2000)
});

/**
 * POST /image-edit
 * Edit an existing story image using AI
 */
router.post('/', async (req, res) => {
  try {
    const { storyId, imageUrl, userRequest } = ImageEditRequestSchema.parse(req.body);

    logger.info('Image edit request received', {
      storyId,
      imageUrl,
      userRequestLength: userRequest.length
    });

    // 1. Load story metadata from database and verify it exists
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // 2. Verify the image exists in storage
    const imageExists = await verifyImageExists(imageUrl);
    if (!imageExists) {
      logger.warn('Image not found in storage', { storyId, imageUrl });
      res.status(404).json({
        success: false,
        error: 'Image not found in storage'
      });
      return;
    }

    // 3. Download the original image
    const originalImageBuffer = await downloadImageFromStorage(imageUrl);
    if (!originalImageBuffer) {
      logger.warn('Could not download original image', { storyId, imageUrl });
      res.status(404).json({
        success: false,
        error: 'Could not access original image from storage'
      });
      return;
    }

    // 4. Load system prompt for image editing
    const systemPrompt = await loadImageEditSystemPrompt();

    // 5. Create the complete prompt for AI image editing
    const editPrompt = await createImageEditPrompt(userRequest, systemPrompt);

    logger.info('Created image edit prompt', {
      storyId,
      promptLength: editPrompt.length,
      fullPrompt: editPrompt // Log the complete prompt for debugging
    });

    // 6. Request image editing from AI
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_edit' as const
    };    logger.info('Sending image to AI for editing', {
      storyId,
      originalImageSize: originalImageBuffer.length,
      imageFormat: 'Buffer (sent as base64 to AI)',
      promptPreview: editPrompt.substring(0, 200) + '...'
    });

    // Use the edit method instead of generate for image editing
    const imageService = aiGateway.getImageService(aiContext);
    let editedImageBuffer: Buffer;
    
    if (imageService.edit) {
      editedImageBuffer = await imageService.edit(editPrompt, originalImageBuffer, {
        width: 1024,
        height: 1536,
        quality: 'standard'
      });
    } else {
      // Fallback to generate method if edit is not available
      logger.warn('Image service does not support edit method, falling back to generate');
      editedImageBuffer = await imageService.generate(editPrompt, {
        width: 1024,
        height: 1536,
        quality: 'standard'
      });
    }

    logger.info('AI image editing completed', {
      storyId,
      originalImageSize: originalImageBuffer.length,
      editedImageSize: editedImageBuffer.length
    });    // 7. Generate new filename with version suffix
    const newFilename = await generateVersionedFilename(imageUrl);

    // 8. Upload the edited image to storage
    const newImageUrl = await storageService.uploadFile(
      newFilename,
      editedImageBuffer,
      'image/png'
    );

    logger.info('Image edit completed successfully', {
      storyId,
      originalImageUrl: imageUrl,
      newImageUrl,
      newFilename
    });

    res.json({
      success: true,
      storyId,
      originalImageUrl: imageUrl,
      newImageUrl,
      userRequest,
      metadata: {
        originalImageSize: originalImageBuffer.length,
        editedImageSize: editedImageBuffer.length,
        filename: newFilename,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Image edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.body?.storyId,
      imageUrl: req.body?.imageUrl
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Image editing failed'
    });
  }
});

/**
 * Verify that an image exists in Google Cloud Storage
 */
async function verifyImageExists(imageUrl: string): Promise<boolean> {
  try {
    const filename = extractFilenameFromUrl(imageUrl);
    if (!filename) {
      return false;
    }
    
    return await storageService.fileExists(filename);
  } catch (error) {
    logger.error('Error verifying image existence', {
      imageUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Download image content from Google Cloud Storage
 */
async function downloadImageFromStorage(imageUrl: string): Promise<Buffer | null> {
  try {
    // Convert gs:// URL to https:// URL if needed
    let downloadUrl = imageUrl;
    if (imageUrl.startsWith('gs://')) {
      // Convert gs://bucket/path to https://storage.googleapis.com/bucket/path
      downloadUrl = imageUrl.replace('gs://', 'https://storage.googleapis.com/');
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      logger.error('Failed to download image', {
        imageUrl,
        downloadUrl,
        status: response.status,
        statusText: response.statusText
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    logger.error('Error downloading image from storage', {
      imageUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Load the system prompt for image editing
 */
async function loadImageEditSystemPrompt(): Promise<string> {
  try {
    const promptPath = join(__dirname, '..', 'prompts', 'image-edit-system.md');
    return await readFile(promptPath, 'utf-8');
  } catch (error) {
    logger.error('Failed to load image edit system prompt', {
      error: error instanceof Error ? error.message : String(error)
    });
    // Fallback prompt
    return `You are an expert AI image editor. Edit the provided image according to the user's request while maintaining the artistic style and quality of the original image.`;
  }
}

/**
 * Create the complete prompt for AI image editing
 */
async function createImageEditPrompt(userRequest: string, systemPrompt: string): Promise<string> {
  return `${systemPrompt}

## User Request:
${userRequest}

## Instructions:
Based on the original image provided and the user's specific request above, generate an edited version of the image that fulfills the user's requirements while maintaining the artistic quality and style of the original.`;
}

/**
 * Generate a versioned filename for the edited image
 */
async function generateVersionedFilename(originalUrl: string): Promise<string> {
  const filename = extractFilenameFromUrl(originalUrl);
  if (!filename) {
    // Fallback filename if extraction fails
    return `edited_image_v001.png`;
  }

  // Extract base filename without extension
  const lastDotIndex = filename.lastIndexOf('.');
  let baseName = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
  const extension = lastDotIndex > 0 ? filename.substring(lastDotIndex) : '.png';

  // Remove existing version numbers (v001, v2, etc.) and date patterns
  baseName = baseName.replace(/_v\d{3}$/, ''); // Remove _v001, _v002, etc.
  baseName = baseName.replace(/_v\d+_.*$/, ''); // Remove _v2_date... pattern
  baseName = baseName.replace(/_\d{4}-\d{2}-\d{2}T.*$/, ''); // Remove date patterns

  // Extract story ID from filename for querying existing versions
  const storyIdMatch = filename.match(/^([a-f0-9-]{36})/);
  if (!storyIdMatch) {
    // If no story ID found, just use v001
    return `${baseName}_v001${extension}`;
  }

  try {
    // Check for existing versioned files to determine next version
    const env = getEnvironment();
    const storage = new Storage({
      projectId: env.GOOGLE_CLOUD_PROJECT_ID
    });
    const bucket = storage.bucket(env.STORAGE_BUCKET_NAME);
      // Get the directory path (everything except the filename)
    const pathParts = filename.split('/');
    pathParts.pop(); // Remove the filename
    const directoryPath = pathParts.join('/');
    
    // Search for existing versions
    const searchPrefix = directoryPath ? `${directoryPath}/${baseName}_v` : `${baseName}_v`;
    const [files] = await bucket.getFiles({ prefix: searchPrefix });
    
    let highestVersion = 0;
    
    // Find highest version number
    for (const file of files) {
      const existingFilename = file.name.split('/').pop() || '';      const versionMatch = existingFilename.match(/_v(\d{3})/);
      if (versionMatch && versionMatch[1]) {
        const existingVersion = parseInt(versionMatch[1], 10);
        if (existingVersion > highestVersion) {
          highestVersion = existingVersion;
        }
      }
    }
    
    // Generate next version with zero-padded format
    const nextVersion = (highestVersion + 1).toString().padStart(3, '0');
    return directoryPath ? `${directoryPath}/${baseName}_v${nextVersion}${extension}` : `${baseName}_v${nextVersion}${extension}`;
    
  } catch (error) {
    logger.error('Error checking existing versions, using v001', {
      originalUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    // Fallback to v001 if there's an error
    const directoryPath = filename.split('/').slice(0, -1).join('/');
    return directoryPath ? `${directoryPath}/${baseName}_v001${extension}` : `${baseName}_v001${extension}`;
  }
}

/**
 * Extract filename from a Google Cloud Storage URL
 */
function extractFilenameFromUrl(url: string): string | null {
  try {
    if (url.startsWith('gs://')) {
      // gs://bucket-name/path/to/file.ext -> path/to/file.ext
      const parts = url.split('/');
      return parts.slice(3).join('/'); // Skip gs:, empty string, and bucket name
    } else if (url.startsWith('https://storage.googleapis.com/')) {
      // https://storage.googleapis.com/bucket-name/path/to/file.ext -> path/to/file.ext
      const parts = url.split('/');
      return parts.slice(4).join('/'); // Skip https:, empty string, storage.googleapis.com, and bucket name
    }
    return null;
  } catch (error) {
    logger.error('Error extracting filename from URL', {
      url,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export { router as imageEditRouter };
