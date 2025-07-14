/**
 * Image Edit API Routes
 * RESTful endpoints for editing existing story    }

    // 2. Download original image using provided URI
    const originalImageFilename = extractFilenameFromUri(originalImageUri);
    let originalImageBuffer: Buffer;
    
    try {
      originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
    } catch (downloadError) {
      sendErrorResponse(res, 500, 'Failed to download original image', {
        storyId,
        originalImageUri,
        originalImageFilename,
        error: downloadError instanceof Error ? downloadError.message : String(downloadError)
      });
      return;
    }

    // 3. Generate new image filename with incremented version
    const newBackcoverFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri)); New database-driven approach using chapters table
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { StorageService } from '@/services/storage.js';
import { PromptService } from '@/services/prompt.js';
import { AIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';
import { 
  extractFilenameFromUri, 
  generateNextVersionFilename, 
  buildImageEditPrompt,
  getImageDimensions 
} from '@/utils/imageUtils.js';

const router = Router();

// Initialize services
const storyService = new StoryService();
const chaptersService = new ChaptersService();
const storageService = new StorageService();
const aiGateway = AIGatewayWithTokenTracking.fromEnvironment();

// Request schemas
const ImageEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000),
  originalImageUri: z.string().url('Valid image URI is required'),
  graphicalStyle: z.string().optional()
});

/**
 * Enhanced error response helper
 */
function sendErrorResponse(res: any, statusCode: number, message: string, details?: any) {
  logger.error(`Image edit error: ${message}`, details);
  
  // Log error to console as requested
  console.error(`Image Edit Error [${statusCode}]: ${message}`, details);
  
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(details && { details })
  });
}

/**
 * PATCH /stories/:storyId/images/front-cover
 * Edit the front cover image of a story using AI
 */
router.patch('/stories/:storyId/images/front-cover', async (req, res) => {
  try {
    const storyId = req.params.storyId;
    const { userRequest, originalImageUri, graphicalStyle } = ImageEditRequestSchema.parse(req.body);

    if (!storyId) {
      sendErrorResponse(res, 400, 'Invalid storyId');
      return;
    }

    logger.info('Front cover edit request received', {
      storyId,
      userRequestLength: userRequest.length,
      originalImageUri,
      graphicalStyle
    });

    // 1. Load story from database (for verification only)
    const story = await storyService.getStory(storyId);
    if (!story) {
      sendErrorResponse(res, 404, 'Story not found', { storyId });
      return;
    }

    // 2. Download original image using provided URI
    const originalImageFilename = extractFilenameFromUri(originalImageUri);
    let originalImageBuffer: Buffer;
    
    try {
      originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
    } catch (downloadError) {
      sendErrorResponse(res, 500, 'Failed to download original image', {
        storyId,
        originalImageUri,
        originalImageFilename,
        error: downloadError instanceof Error ? downloadError.message : String(downloadError)
      });
      return;
    }

    // 3. Generate new image filename with incremented version
    const newCoverFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

    // 4. Get image editing prompt with style integration
    let stylePrompt: string | undefined;
    if (graphicalStyle) {
      try {
        const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
        stylePrompt = styleConfig.style;
      } catch (styleError) {
        logger.warn('Failed to get style prompt, continuing without style', { 
          graphicalStyle, 
          error: styleError instanceof Error ? styleError.message : String(styleError) 
        });
      }
    }

    const imagePrompt = buildImageEditPrompt(userRequest, graphicalStyle, stylePrompt);

    // 5. Get image dimensions from environment configuration
    const dimensions = getImageDimensions('front_cover');

    // 6. Edit image using AI with original image
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_edit' as const
    };

    let imageBuffer: Buffer;
    try {
      const imageService = aiGateway.getImageService(aiContext);
      if (!imageService.edit) {
        sendErrorResponse(res, 500, 'Image editing not supported by current AI provider');
        return;
      }

      imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
        width: dimensions.width,
        height: dimensions.height,
        imageType: 'front_cover',
        ...(graphicalStyle && { graphicalStyle })
      });
    } catch (editError) {
      sendErrorResponse(res, 500, 'AI image editing failed', {
        storyId,
        error: editError instanceof Error ? editError.message : String(editError)
      });
      return;
    }

    // 9. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newCoverFilename, imageBuffer, 'image/jpeg');

    logger.info('Front cover image edit completed', {
      storyId,
      originalUri: originalImageUri,
      newUri: newImageUrl,
      newFilename: newCoverFilename
    });

    // 10. Return the new image URL
    res.json({
      success: true,
      storyId,
      imageType: 'front_cover',
      newImageUrl,
      metadata: {
        originalUri: originalImageUri,
        filename: newCoverFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString(),
        userRequest,
        dimensions
      }
    });

  } catch (error) {
    sendErrorResponse(res, 500, 'Front cover editing failed', {
      storyId: req.params?.storyId,
      error: error instanceof Error ? error.message : String(error)
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
    const { userRequest, originalImageUri, graphicalStyle } = ImageEditRequestSchema.parse(req.body);

    if (!storyId) {
      sendErrorResponse(res, 400, 'Invalid storyId');
      return;
    }

    logger.info('Back cover edit request received', {
      storyId,
      userRequestLength: userRequest.length,
      originalImageUri,
      graphicalStyle
    });

    // 1. Load story from database (for verification only)
    const story = await storyService.getStory(storyId);
    if (!story) {
      sendErrorResponse(res, 404, 'Story not found', { storyId });
      return;
    }

    // 2. Download original image using provided URI
    const originalImageFilename = extractFilenameFromUri(originalImageUri);
    let originalImageBuffer: Buffer;
    
    try {
      originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
    } catch (downloadError) {
      sendErrorResponse(res, 500, 'Failed to download original image', {
        storyId,
        originalImageFilename,
        error: downloadError instanceof Error ? downloadError.message : String(downloadError)
      });
      return;
    }

    // 3. Generate new image filename with incremented version
    const newBackcoverFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

    // 4. Get image editing prompt with style integration
    let stylePrompt: string | undefined;
    if (graphicalStyle) {
      try {
        const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
        stylePrompt = styleConfig.style;
      } catch (styleError) {
        logger.warn('Failed to get style prompt, continuing without style', { 
          graphicalStyle, 
          error: styleError instanceof Error ? styleError.message : String(styleError) 
        });
      }
    }

    const imagePrompt = buildImageEditPrompt(userRequest, graphicalStyle, stylePrompt);

    // 5. Get image dimensions from environment configuration
    const dimensions = getImageDimensions('back_cover');

    // 6. Edit image using AI with original image
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_edit' as const
    };

    let imageBuffer: Buffer;
    try {
      const imageService = aiGateway.getImageService(aiContext);
      if (!imageService.edit) {
        sendErrorResponse(res, 500, 'Image editing not supported by current AI provider');
        return;
      }

      imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
        width: dimensions.width,
        height: dimensions.height,
        imageType: 'back_cover',
        ...(graphicalStyle && { graphicalStyle })
      });
    } catch (editError) {
      sendErrorResponse(res, 500, 'AI image editing failed', {
        storyId,
        error: editError instanceof Error ? editError.message : String(editError)
      });
      return;
    }

    // 7. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newBackcoverFilename, imageBuffer, 'image/jpeg');

    logger.info('Back cover image edit completed', {
      storyId,
      originalUri: originalImageUri,
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
        originalUri: originalImageUri,
        filename: newBackcoverFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString(),
        userRequest,
        dimensions
      }
    });

  } catch (error) {
    sendErrorResponse(res, 500, 'Back cover editing failed', {
      storyId: req.params?.storyId,
      error: error instanceof Error ? error.message : String(error)
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
    const { userRequest, originalImageUri, graphicalStyle } = ImageEditRequestSchema.parse(req.body);

    if (!storyId || isNaN(chapterNumber) || chapterNumber < 1) {
      sendErrorResponse(res, 400, 'Invalid storyId or chapterNumber');
      return;
    }

    logger.info('Chapter image edit request received', {
      storyId,
      chapterNumber,
      userRequestLength: userRequest.length,
      originalImageUri,
      graphicalStyle
    });

    // 1. Load story from database (for verification only)
    const story = await storyService.getStory(storyId);
    if (!story) {
      sendErrorResponse(res, 404, 'Story not found', { storyId });
      return;
    }

    // 2. Get the specific chapter from database (for verification only)
    const storyChapters = await chaptersService.getStoryChapters(storyId);
    const targetChapter = storyChapters.find(ch => ch.chapterNumber === chapterNumber);
    
    if (!targetChapter) {
      sendErrorResponse(res, 404, `Chapter ${chapterNumber} not found`, { storyId, chapterNumber });
      return;
    }

    // 3. Download original image using provided URI
    const originalImageFilename = extractFilenameFromUri(originalImageUri);
    let originalImageBuffer: Buffer;
    
    try {
      originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
    } catch (downloadError) {
      sendErrorResponse(res, 500, 'Failed to download original chapter image', {
        storyId,
        chapterNumber,
        originalImageUri,
        originalImageFilename,
        error: downloadError instanceof Error ? downloadError.message : String(downloadError)
      });
      return;
    }

    // 4. Generate new image filename with incremented version
    const newImageFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

    // 5. Get image editing prompt with style integration
    let stylePrompt: string | undefined;
    if (graphicalStyle) {
      try {
        const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
        stylePrompt = styleConfig.style;
      } catch (styleError) {
        logger.warn('Failed to get style prompt, continuing without style', { 
          graphicalStyle, 
          error: styleError instanceof Error ? styleError.message : String(styleError) 
        });
      }
    }

    const imagePrompt = buildImageEditPrompt(userRequest, graphicalStyle, stylePrompt);

    // 6. Get image dimensions from environment configuration
    const dimensions = getImageDimensions('chapter');

    // 7. Edit image using AI with original image
    const aiContext = {
      authorId: story.authorId,
      storyId: storyId,
      action: 'image_edit' as const
    };

    let imageBuffer: Buffer;
    try {
      const imageService = aiGateway.getImageService(aiContext);
      if (!imageService.edit) {
        sendErrorResponse(res, 500, 'Image editing not supported by current AI provider');
        return;
      }

      imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
        width: dimensions.width,
        height: dimensions.height,
        imageType: 'chapter',
        ...(graphicalStyle && { graphicalStyle })
      });
    } catch (editError) {
      sendErrorResponse(res, 500, 'AI chapter image editing failed', {
        storyId,
        chapterNumber,
        error: editError instanceof Error ? editError.message : String(editError)
      });
      return;
    }

    // 10. Upload new image to storage
    const newImageUrl = await storageService.uploadFile(newImageFilename, imageBuffer, 'image/jpeg');

    logger.info('Chapter image edit completed', {
      storyId,
      chapterNumber,
      originalUri: originalImageUri,
      newUri: newImageUrl,
      newFilename: newImageFilename
    });

    // 8. Return the new image URL
    res.json({
      success: true,
      storyId,
      chapterNumber,
      imageType: 'chapter',
      newImageUrl,
      metadata: {
        originalUri: originalImageUri,
        filename: newImageFilename,
        size: imageBuffer.length,
        timestamp: new Date().toISOString(),
        userRequest,
        dimensions
      }
    });

  } catch (error) {
    sendErrorResponse(res, 500, 'Chapter image editing failed', {
      storyId: req.params?.storyId,
      chapterNumber: req.params?.chapterNumber,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
export { router as imageEditRouter };
