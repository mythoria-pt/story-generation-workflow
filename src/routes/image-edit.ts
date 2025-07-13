/**
 * Image Edit API Routes
 * RESTful endpoints for editing existing story images using AI
 * New database-driven approach using chapters table
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { StorageService } from '@/services/storage.js';
import { AIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';

const router = Router();

// Initialize services
const storyService = new StoryService();
const chaptersService = new ChaptersService();
const storageService = new StorageService();
const aiGateway = AIGatewayWithTokenTracking.fromEnvironment();

// Request schemas
const ImageEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000)
});

/**
 * Generate next version filename for an image
 */
function generateNextVersionFilename(currentUri: string): string {
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
 * Extract filename from Google Storage URI
 */
function extractFilenameFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    const pathParts = url.pathname.split('/');
    return pathParts[pathParts.length - 1] || 'image.jpg';
  } catch {
    // Fallback: get everything after last slash
    return uri.split('/').pop() || 'image.jpg';
  }
}

/**
 * PATCH /stories/:storyId/images/front-cover
 * Edit the front cover image of a story using AI
 */
router.patch('/stories/:storyId/images/front-cover', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const { userRequest } = ImageEditRequestSchema.parse(req.body);

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'Invalid storyId'
      });
      return;
    }

    logger.info('Front cover edit request received', {
      storyId,
      userRequestLength: userRequest.length
    });

    // 1. Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // 2. Check if story has a front cover URI
    if (!story.coverUri) {
      logger.warn('Story has no front cover image', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story has no front cover image'
      });
      return;
    }

    // 3. Generate new image filename with incremented version
    const currentCoverUri = story.coverUri;
    const newCoverFilename = extractFilenameFromUri(generateNextVersionFilename(currentCoverUri));

    // 4. Load story context for AI prompt
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context'
      });
      return;
    }

    // 5. Create image generation prompt
    const imagePrompt = `Book front cover for "${storyContext.story.title}". ${userRequest}. Style: ${storyContext.story.graphicalStyle || 'colorful and vibrant illustration'}.`;

    // 6. Generate new image using AI
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_generation' as const
    };

    const imageBuffer = await aiGateway.getImageService(aiContext).generate(imagePrompt, {
      width: 1024,
      height: 1536, // Portrait format for book cover
      imageType: 'front_cover',
      bookTitle: storyContext.story.title,
      graphicalStyle: storyContext.story.graphicalStyle
    });

    // 7. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newCoverFilename, imageBuffer, 'image/jpeg');

    logger.info('Front cover image edit completed', {
      storyId,
      originalUri: currentCoverUri,
      newUri: newImageUrl,
      newFilename: newCoverFilename
    });

    // 8. Return the new image URL
    res.json({
      success: true,
      storyId,
      imageType: 'front_cover',
      newImageUrl,
      metadata: {
        originalUri: currentCoverUri,
        filename: newCoverFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Front cover edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params?.storyId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Front cover editing failed'
    });
  }
});

/**
 * PATCH /stories/:storyId/images/back-cover
 * Edit the back cover image of a story using AI
 */
router.patch('/stories/:storyId/images/back-cover', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const { userRequest } = ImageEditRequestSchema.parse(req.body);

    if (!storyId) {
      res.status(400).json({
        success: false,
        error: 'Invalid storyId'
      });
      return;
    }

    logger.info('Back cover edit request received', {
      storyId,
      userRequestLength: userRequest.length
    });

    // 1. Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // 2. Check if story has a back cover URI
    if (!story.backcoverUri) {
      logger.warn('Story has no back cover image', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story has no back cover image'
      });
      return;
    }

    // 3. Generate new image filename with incremented version
    const currentBackcoverUri = story.backcoverUri;
    const newBackcoverFilename = extractFilenameFromUri(generateNextVersionFilename(currentBackcoverUri));

    // 4. Load story context for AI prompt
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context'
      });
      return;
    }

    // 5. Create image generation prompt
    const imagePrompt = `Book back cover for "${storyContext.story.title}". ${userRequest}. Style: ${storyContext.story.graphicalStyle || 'colorful and vibrant illustration'}.`;

    // 6. Generate new image using AI
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_generation' as const
    };

    const imageBuffer = await aiGateway.getImageService(aiContext).generate(imagePrompt, {
      width: 1024,
      height: 1536, // Portrait format for book cover
      imageType: 'back_cover',
      bookTitle: storyContext.story.title,
      graphicalStyle: storyContext.story.graphicalStyle
    });

    // 7. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newBackcoverFilename, imageBuffer, 'image/jpeg');

    logger.info('Back cover image edit completed', {
      storyId,
      originalUri: currentBackcoverUri,
      newUri: newImageUrl,
      newFilename: newBackcoverFilename
    });

    // 8. Return the new image URL
    res.json({
      success: true,
      storyId,
      imageType: 'back_cover',
      newImageUrl,
      metadata: {
        originalUri: currentBackcoverUri,
        filename: newBackcoverFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Back cover edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params?.storyId
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Back cover editing failed'
    });
  }
});

/**
 * PATCH /stories/:storyId/chapters/:chapterNumber/image
 * Edit a chapter image of a story using AI
 */
router.patch('/stories/:storyId/chapters/:chapterNumber/image', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const chapterNumber = parseInt(req.params.chapterNumber);
    const { userRequest } = ImageEditRequestSchema.parse(req.body);

    if (!storyId || isNaN(chapterNumber) || chapterNumber < 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid storyId or chapterNumber'
      });
      return;
    }

    logger.info('Chapter image edit request received', {
      storyId,
      chapterNumber,
      userRequestLength: userRequest.length
    });

    // 1. Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      logger.warn('Story not found', { storyId });
      res.status(404).json({
        success: false,
        error: 'Story not found'
      });
      return;
    }

    // 2. Get the specific chapter from database
    const storyChapters = await chaptersService.getStoryChapters(storyId);
    const targetChapter = storyChapters.find(ch => ch.chapterNumber === chapterNumber);
    
    if (!targetChapter) {
      logger.warn('Chapter not found', { storyId, chapterNumber });
      res.status(404).json({
        success: false,
        error: `Chapter ${chapterNumber} not found`
      });
      return;
    }

    // 3. Check if chapter has an image
    if (!targetChapter.imageUri) {
      logger.warn('Chapter has no image', { storyId, chapterNumber });
      res.status(404).json({
        success: false,
        error: `Chapter ${chapterNumber} has no image`
      });
      return;
    }

    // 4. Generate new image filename with incremented version
    const currentImageUri = targetChapter.imageUri;
    const newImageFilename = extractFilenameFromUri(generateNextVersionFilename(currentImageUri));

    // 5. Load story context for AI prompt
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.error('Could not load story context', { storyId });
      res.status(500).json({
        success: false,
        error: 'Could not load story context'
      });
      return;
    }

    // 6. Create image generation prompt
    const imagePrompt = `Chapter illustration for "${targetChapter.title}" from "${storyContext.story.title}". ${userRequest}. Style: ${storyContext.story.graphicalStyle || 'colorful and vibrant illustration'}.`;

    // 7. Generate new image using AI
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_generation' as const
    };

    const imageBuffer = await aiGateway.getImageService(aiContext).generate(imagePrompt, {
      width: 1024,
      height: 1024, // Square format for chapter illustration
      imageType: 'chapter',
      bookTitle: storyContext.story.title,
      graphicalStyle: storyContext.story.graphicalStyle
    });

    // 8. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newImageFilename, imageBuffer, 'image/jpeg');

    logger.info('Chapter image edit completed', {
      storyId,
      chapterNumber,
      originalUri: currentImageUri,
      newUri: newImageUrl,
      newFilename: newImageFilename
    });

    // 9. Return the new image URL
    res.json({
      success: true,
      storyId,
      chapterNumber,
      imageType: 'chapter',
      newImageUrl,
      metadata: {
        originalUri: currentImageUri,
        filename: newImageFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Chapter image edit request failed', {
      error: error instanceof Error ? error.message : String(error),
      storyId: req.params?.storyId,
      chapterNumber: req.params?.chapterNumber
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Chapter image editing failed'
    });
  }
});
export { router as imageEditRouter };
