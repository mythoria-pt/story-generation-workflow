/**
 * Image Edit Worker
 * Processes async image editing jobs by calling existing image-edit functionality
 */

import { logger } from '@/config/logger.js';
import { jobManager } from '@/services/job-manager.js';

// Import the existing image edit route logic
import { StoryService } from '@/services/story.js';
import { ChaptersService } from '@/services/chapters.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { PromptService } from '@/services/prompt.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking-v2.js';
import { 
  extractFilenameFromUri, 
  generateNextVersionFilename, 
  buildImageEditPrompt,
  getImageDimensions 
} from '@/utils/imageUtils.js';

// Initialize services
const storyService = new StoryService();
const chaptersService = new ChaptersService();
const storageService = getStorageService();
const aiGateway = getAIGatewayWithTokenTracking();

interface ImageEditJobParams {
  storyId: string;
  imageUrl: string;
  imageType: 'cover' | 'backcover' | 'chapter';
  userRequest: string;
  chapterNumber?: number;
  graphicalStyle?: string;
}

/**
 * Process an image editing job asynchronously
 */
export async function processImageEditJob(jobId: string, params: ImageEditJobParams): Promise<void> {
  try {
    logger.info('Starting image edit job processing', { jobId, params });

    const { storyId, imageUrl, imageType, userRequest, chapterNumber, graphicalStyle } = params;

    // Update job status to processing
    jobManager.updateJobStatus(jobId, 'processing');

    // Load story from database
    const story = await storyService.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    // Process the image edit based on type
    let result: any;

    switch (imageType) {
      case 'cover':
        result = await processFrontCoverEdit(story, imageUrl, userRequest, graphicalStyle);
        break;
      case 'backcover':
        result = await processBackCoverEdit(story, imageUrl, userRequest, graphicalStyle);
        break;
      case 'chapter':
        if (!chapterNumber) {
          throw new Error('Chapter number is required for chapter image editing');
        }
        result = await processChapterImageEdit(story, imageUrl, userRequest, chapterNumber, graphicalStyle);
        break;
      default:
        throw new Error(`Unsupported image type: ${imageType}`);
    }

    // Mark job as completed with result
    jobManager.updateJobStatus(jobId, 'completed', result);

    logger.info('Image edit job completed successfully', { 
      jobId, 
      storyId, 
      imageType,
      newImageUrl: result.newImageUrl 
    });

  } catch (error) {
    logger.error('Image edit job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error)
    });

    jobManager.updateJobStatus(jobId, 'failed', undefined, 
      error instanceof Error ? error.message : 'Image editing failed'
    );
  }
}

/**
 * Process front cover image edit (extracted from existing image-edit.ts logic)
 */
async function processFrontCoverEdit(
  story: any, 
  originalImageUri: string, 
  userRequest: string,
  graphicalStyle?: string
): Promise<any> {
  // 1. Download original image using provided URI
  const originalImageFilename = extractFilenameFromUri(originalImageUri);
  let originalImageBuffer: Buffer;
  
  try {
    originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
  } catch (downloadError) {
    throw new Error(`Failed to download original image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

  // 2. Generate new image filename with incremented version
  const newCoverFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

  // 3. Get image editing prompt with style integration
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

  // 4. Get image dimensions from environment configuration
  const dimensions = getImageDimensions('front_cover');

  // 5. Edit image using AI with original image
  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    if (!imageService.edit) {
      throw new Error('Image editing not supported by current AI provider');
    }

    imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'front_cover',
      ...(graphicalStyle && { graphicalStyle })
    });
  } catch (editError) {
    throw new Error(`AI image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 6. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newCoverFilename, imageBuffer, 'image/jpeg');

  logger.info('Front cover image edit completed', {
    storyId: story.storyId,
    originalUri: originalImageUri,
    newUri: newImageUrl,
    newFilename: newCoverFilename
  });

  return {
    success: true,
    storyId: story.storyId,
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
  };
}

/**
 * Process back cover image edit (extracted from existing image-edit.ts logic)
 */
async function processBackCoverEdit(
  story: any, 
  originalImageUri: string, 
  userRequest: string,
  graphicalStyle?: string
): Promise<any> {
  // 1. Download original image using provided URI
  const originalImageFilename = extractFilenameFromUri(originalImageUri);
  let originalImageBuffer: Buffer;
  
  try {
    originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
  } catch (downloadError) {
    throw new Error(`Failed to download original image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

  // 2. Generate new image filename with incremented version
  const newBackcoverFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

  // 3. Get image editing prompt with style integration
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

  // 4. Get image dimensions from environment configuration
  const dimensions = getImageDimensions('back_cover');

  // 5. Edit image using AI with original image
  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    if (!imageService.edit) {
      throw new Error('Image editing not supported by current AI provider');
    }

    imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'back_cover',
      ...(graphicalStyle && { graphicalStyle })
    });
  } catch (editError) {
    throw new Error(`AI image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 6. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newBackcoverFilename, imageBuffer, 'image/jpeg');

  logger.info('Back cover image edit completed', {
    storyId: story.storyId,
    originalUri: originalImageUri,
    newUri: newImageUrl,
    newFilename: newBackcoverFilename
  });

  return {
    success: true,
    storyId: story.storyId,
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
  };
}

/**
 * Process chapter image edit (extracted from existing image-edit.ts logic)
 */
async function processChapterImageEdit(
  story: any, 
  originalImageUri: string, 
  userRequest: string, 
  chapterNumber: number,
  graphicalStyle?: string
): Promise<any> {
  // 1. Validate that chapter exists
  const storyChapters = await chaptersService.getStoryChapters(story.storyId);
  const targetChapter = storyChapters.find(ch => ch.chapterNumber === chapterNumber);
  
  if (!targetChapter) {
    throw new Error(`Chapter ${chapterNumber} not found`);
  }

  // 2. Download original image using provided URI
  const originalImageFilename = extractFilenameFromUri(originalImageUri);
  let originalImageBuffer: Buffer;
  
  try {
    originalImageBuffer = await storageService.downloadFileAsBuffer(originalImageFilename);
  } catch (downloadError) {
    throw new Error(`Failed to download original chapter image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

  // 3. Generate new image filename with incremented version
  const newImageFilename = extractFilenameFromUri(generateNextVersionFilename(originalImageUri));

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
  const dimensions = getImageDimensions('chapter');

  // 6. Edit image using AI with original image
  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    if (!imageService.edit) {
      throw new Error('Image editing not supported by current AI provider');
    }

    imageBuffer = await imageService.edit(imagePrompt, originalImageBuffer, {
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'chapter',
      ...(graphicalStyle && { graphicalStyle })
    });
  } catch (editError) {
    throw new Error(`AI chapter image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 7. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newImageFilename, imageBuffer, 'image/jpeg');

  logger.info('Chapter image edit completed', {
    storyId: story.storyId,
    chapterNumber,
    originalUri: originalImageUri,
    newUri: newImageUrl,
    newFilename: newImageFilename
  });

  return {
    success: true,
    storyId: story.storyId,
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
  };
}
