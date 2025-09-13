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
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
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
  userRequest?: string; // optional when converting with only reference image
  chapterNumber?: number;
  graphicalStyle?: string;
  userImageUri?: string; // user uploaded image used for style conversion or reference
  convertToStyle?: boolean; // when true, treat userImageUri as the base to restyle
}

/** Infer a naive mime type for a stored filename */
function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

/**
 * Produces a structured textual description of the supplied base image using the text model's multimodal capabilities.
 * This is used to anchor the fallback generation path when the provider lacks a true edit() endpoint.
 */
async function describeBaseImage(
  buffer: Buffer,
  mimeType: string,
  imageType: 'front_cover' | 'back_cover' | 'chapter',
  aiContext: { authorId: string; storyId: string; action: 'image_edit' }
): Promise<string | undefined> {
  try {
    const textService = aiGateway.getTextService(aiContext);
    const system = `You are an expert visual analyst. Provide a precise, objective description of the given ${imageType.replace('_',' ')} image for a story illustration transformation task.
Return JSON with fields: subjects (array of key entities), setting (concise environment), composition (framing/angle), palette (dominant colors), mood (few adjectives), key_details (salient props / clothing), lighting (brief), style_notes (artistic style hints). Do NOT hallucinate.`;
    const user = 'Analyze the attached image. Output ONLY compact JSON. No markdown.';
    // We piggyback on complete() even if provider ignores mediaParts (then we just proceed without description).
    const prompt = `${system}\n\n${user}`;
    const result = await textService.complete(prompt, {
      mediaParts: [ { mimeType, data: buffer } ],
      // Omit maxTokens to allow provider-specific model maximum via getMaxOutputTokens()
      temperature: 0.2
    } as any);
    // Basic sanitation: ensure looks like JSON
    const jsonStart = result.indexOf('{');
    const jsonEnd = result.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const maybe = result.slice(jsonStart, jsonEnd + 1).trim();
      if (maybe.length < 4000) {
        return maybe;
      }
    }
    return undefined;
  } catch (e) {
    logger.warn('Base image description failed; continuing without', { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/**
 * Process an image editing job asynchronously
 */
export async function processImageEditJob(jobId: string, params: ImageEditJobParams): Promise<void> {
  try {
    logger.info('Starting image edit job processing', { jobId, params });

  const { storyId, imageUrl, imageType, userRequest, chapterNumber, graphicalStyle, userImageUri, convertToStyle } = params;

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
  result = await processFrontCoverEdit(story, imageUrl, userRequest, graphicalStyle, userImageUri, convertToStyle);
        break;
      case 'backcover':
  result = await processBackCoverEdit(story, imageUrl, userRequest, graphicalStyle, userImageUri, convertToStyle);
        break;
      case 'chapter':
        if (!chapterNumber) {
          throw new Error('Chapter number is required for chapter image editing');
        }
  result = await processChapterImageEdit(story, imageUrl, userRequest, chapterNumber, graphicalStyle, userImageUri, convertToStyle);
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
  userRequest: string | undefined,
  graphicalStyle?: string,
  userImageUri?: string,
  convertToStyle?: boolean
): Promise<any> {
  // 1. Download original image using provided URI
  const baseImageUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
  const baseImageFilename = extractFilenameFromUri(baseImageUri);
  let baseImageBuffer: Buffer;
  
  try {
  baseImageBuffer = await storageService.downloadFileAsBuffer(baseImageFilename);
  } catch (downloadError) {
  throw new Error(`Failed to download base image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

    // 2. Generate new image filename with incremented version
    // If we're converting a freshly uploaded user image (already v002), we must base the next version off that user image
    const coverVersionBaseUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
    const newCoverFilename = extractFilenameFromUri(generateNextVersionFilename(coverVersionBaseUri));

  // 3. Get image editing prompt with style integration
  let stylePrompt: string | undefined;
  let fullStyleSystemPrompt: string | undefined;
  if (graphicalStyle) {
    try {
      const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
      stylePrompt = styleConfig.style;
      fullStyleSystemPrompt = styleConfig.systemPrompt;
    } catch (styleError) {
      logger.warn('Failed to get style prompt, continuing without style', { 
        graphicalStyle, 
        error: styleError instanceof Error ? styleError.message : String(styleError) 
      });
    }
  }

  // Prepare AI context first (needed for optional description)
  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };

  // Optionally obtain semantic description for fallback / style conversion scenarios.
  let baseImageDescription: string | undefined;
  if (convertToStyle) {
    try {
      baseImageDescription = await describeBaseImage(baseImageBuffer, guessMimeType(baseImageFilename), 'front_cover', aiContext);
    } catch { /* ignore description errors */ }
  }

  const imagePrompt = buildImageEditPrompt(
    // Only append reference guidance if we're not directly converting the uploaded image itself
    (userImageUri && baseImageUri !== userImageUri)
      ? buildUserRequestWithReference(userRequest, userImageUri)
      : (userRequest || ''),
    graphicalStyle,
    stylePrompt,
    !!userImageUri && baseImageUri !== userImageUri,
    fullStyleSystemPrompt
  );

  // 4. Get image dimensions from environment configuration
  const dimensions = getImageDimensions('front_cover');

  // 5. Edit image using AI with original image (aiContext already defined)

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    const canAttemptEdit = typeof imageService.edit === 'function';
    const referenceImageEntry = {
      buffer: baseImageBuffer,
      mimeType: guessMimeType(baseImageFilename),
      source: baseImageUri
    };
    const buildGenerationOptions = () => ({
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'front_cover' as const,
      ...(graphicalStyle && { graphicalStyle }),
      referenceImages: [referenceImageEntry]
    });

  if (canAttemptEdit) {
      try {
        // Call edit() without non-null assertion now that we've confirmed capability
        const editFn = imageService.edit;
        if (!editFn) {
          throw new Error('Invariant: edit function missing after capability check');
        }
        imageBuffer = await editFn(imagePrompt, baseImageBuffer, {
          width: dimensions.width,
          height: dimensions.height,
          imageType: 'front_cover',
          ...(graphicalStyle && { graphicalStyle })
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/does not support editing|not support editing/i.test(msg)) {
      logger.warn('Edit unsupported; falling back to generate() with reference image', { storyId: story.storyId, imageType: 'front_cover' });
          if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
          imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
        } else {
          throw err;
        }
      }
    } else {
      if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      logger.info('Provider lacks edit(); using generate() with reference image to simulate edit', { storyId: story.storyId, imageType: 'front_cover' });
    const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
      imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
    }
  } catch (editError) {
    throw new Error(`AI image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 6. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newCoverFilename, imageBuffer, 'image/jpeg');

  logger.info('Front cover image edit completed', {
    storyId: story.storyId,
  originalUri: originalImageUri,
  baseImageUri,
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
  userRequest: string | undefined,
  graphicalStyle?: string,
  userImageUri?: string,
  convertToStyle?: boolean
): Promise<any> {
  // 1. Download original image using provided URI
  const baseImageUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
  const baseImageFilename = extractFilenameFromUri(baseImageUri);
  let baseImageBuffer: Buffer;
  
  try {
  baseImageBuffer = await storageService.downloadFileAsBuffer(baseImageFilename);
  } catch (downloadError) {
  throw new Error(`Failed to download base image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

    // 2. Generate new image filename with incremented version
    // Use userImageUri as version base when converting style to avoid overwriting the just-uploaded as-is version
    const backcoverVersionBaseUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
    const newBackcoverFilename = extractFilenameFromUri(generateNextVersionFilename(backcoverVersionBaseUri));

  // 3. Get image editing prompt with style integration
  let stylePrompt: string | undefined;
  let fullStyleSystemPrompt: string | undefined;
  if (graphicalStyle) {
    try {
      const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
      stylePrompt = styleConfig.style;
      fullStyleSystemPrompt = styleConfig.systemPrompt;
    } catch (styleError) {
      logger.warn('Failed to get style prompt, continuing without style', { 
        graphicalStyle, 
        error: styleError instanceof Error ? styleError.message : String(styleError) 
      });
    }
  }

  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };
  let baseImageDescription: string | undefined;
  if (convertToStyle) {
    try { baseImageDescription = await describeBaseImage(baseImageBuffer, guessMimeType(baseImageFilename), 'back_cover', aiContext); } catch { /* ignore */ }
  }

  const imagePrompt = buildImageEditPrompt(
    (userImageUri && baseImageUri !== userImageUri)
      ? buildUserRequestWithReference(userRequest, userImageUri)
      : (userRequest || ''),
    graphicalStyle,
    stylePrompt,
    !!userImageUri && baseImageUri !== userImageUri,
    fullStyleSystemPrompt
  );

  // 4. Get image dimensions from environment configuration
  const dimensions = getImageDimensions('back_cover');

  // 5. Edit image using AI with original image (aiContext already defined)

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    const canAttemptEdit = typeof imageService.edit === 'function';
    const referenceImageEntry = {
      buffer: baseImageBuffer,
      mimeType: guessMimeType(baseImageFilename),
      source: baseImageUri
    };
    const buildGenerationOptions = () => ({
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'back_cover' as const,
      ...(graphicalStyle && { graphicalStyle }),
      referenceImages: [referenceImageEntry]
    });

  if (canAttemptEdit) {
      try {
        const editFn = imageService.edit;
        if (!editFn) {
          throw new Error('Invariant: edit function missing after capability check');
        }
        imageBuffer = await editFn(imagePrompt, baseImageBuffer, {
          width: dimensions.width,
          height: dimensions.height,
          imageType: 'back_cover',
          ...(graphicalStyle && { graphicalStyle })
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/does not support editing|not support editing/i.test(msg)) {
      logger.warn('Edit unsupported; falling back to generate() with reference image', { storyId: story.storyId, imageType: 'back_cover' });
          if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
          imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
        } else {
          throw err;
        }
      }
    } else {
      if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      logger.info('Provider lacks edit(); using generate() with reference image to simulate edit', { storyId: story.storyId, imageType: 'back_cover' });
    const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
      imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
    }
  } catch (editError) {
    throw new Error(`AI image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 6. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newBackcoverFilename, imageBuffer, 'image/jpeg');

  logger.info('Back cover image edit completed', {
    storyId: story.storyId,
  originalUri: originalImageUri,
  baseImageUri,
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
  userRequest: string | undefined,
  chapterNumber: number,
  graphicalStyle?: string,
  userImageUri?: string,
  convertToStyle?: boolean
): Promise<any> {
  // 1. Validate that chapter exists
  const storyChapters = await chaptersService.getStoryChapters(story.storyId);
  const targetChapter = storyChapters.find(ch => ch.chapterNumber === chapterNumber);
  
  if (!targetChapter) {
    throw new Error(`Chapter ${chapterNumber} not found`);
  }

  // 2. Download original image using provided URI
  const baseImageUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
  const baseImageFilename = extractFilenameFromUri(baseImageUri);
  let baseImageBuffer: Buffer;
  
  try {
  baseImageBuffer = await storageService.downloadFileAsBuffer(baseImageFilename);
  } catch (downloadError) {
  throw new Error(`Failed to download base chapter image: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
  }

    // 3. Generate new image filename with incremented version
    // When convertToStyle is true and user supplied image was uploaded as next version already, base further increment on that
    const chapterVersionBaseUri = convertToStyle && userImageUri ? userImageUri : originalImageUri;
    const newImageFilename = extractFilenameFromUri(generateNextVersionFilename(chapterVersionBaseUri));

  // 4. Get image editing prompt with style integration
  let stylePrompt: string | undefined;
  let fullStyleSystemPrompt: string | undefined;
  if (graphicalStyle) {
    try {
      const styleConfig = await PromptService.getImageStylePrompt(graphicalStyle);
      stylePrompt = styleConfig.style;
      fullStyleSystemPrompt = styleConfig.systemPrompt;
    } catch (styleError) {
      logger.warn('Failed to get style prompt, continuing without style', { 
        graphicalStyle, 
        error: styleError instanceof Error ? styleError.message : String(styleError) 
      });
    }
  }

  const aiContext = {
    authorId: story.authorId,
    storyId: story.storyId,
    action: 'image_edit' as const
  };
  let baseImageDescription: string | undefined;
  if (convertToStyle) {
    try { baseImageDescription = await describeBaseImage(baseImageBuffer, guessMimeType(baseImageFilename), 'chapter', aiContext); } catch { /* ignore */ }
  }

  const imagePrompt = buildImageEditPrompt(
    (userImageUri && baseImageUri !== userImageUri)
      ? buildUserRequestWithReference(userRequest, userImageUri)
      : (userRequest || ''),
    graphicalStyle,
    stylePrompt,
    !!userImageUri && baseImageUri !== userImageUri,
    fullStyleSystemPrompt
  );

  // 5. Get image dimensions from environment configuration
  const dimensions = getImageDimensions('chapter');

  // 6. Edit image using AI with original image (aiContext already defined)

  let imageBuffer: Buffer;
  try {
    const imageService = aiGateway.getImageService(aiContext);
    const canAttemptEdit = typeof imageService.edit === 'function';
    const referenceImageEntry = {
      buffer: baseImageBuffer,
      mimeType: guessMimeType(baseImageFilename),
      source: baseImageUri
    };
    const buildGenerationOptions = () => ({
      width: dimensions.width,
      height: dimensions.height,
      imageType: 'chapter' as const,
      ...(graphicalStyle && { graphicalStyle }),
      referenceImages: [referenceImageEntry]
    });

  if (canAttemptEdit) {
      try {
        const editFn = imageService.edit;
        if (!editFn) {
          throw new Error('Invariant: edit function missing after capability check');
        }
        imageBuffer = await editFn(imagePrompt, baseImageBuffer, {
          width: dimensions.width,
          height: dimensions.height,
          imageType: 'chapter',
          ...(graphicalStyle && { graphicalStyle })
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/does not support editing|not support editing/i.test(msg)) {
      logger.warn('Edit unsupported; falling back to generate() with reference image', { storyId: story.storyId, imageType: 'chapter', chapterNumber });
          if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
          imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
        } else {
          throw err;
        }
      }
    } else {
      if (!imageService.generate) throw new Error('Image generation not supported by current AI provider');
      logger.info('Provider lacks edit(); using generate() with reference image to simulate edit', { storyId: story.storyId, imageType: 'chapter', chapterNumber });
    const augmentedPrompt = `${imagePrompt}\n\nThe provided reference image MUST anchor subject identity, composition and core visual elements. Only apply style adaptation and the explicitly requested changes.${baseImageDescription ? `\n\nREFERENCE_IMAGE_STRUCTURED_DESCRIPTION:\n${baseImageDescription}` : ''}`;
      imageBuffer = await imageService.generate(augmentedPrompt, buildGenerationOptions());
    }
  } catch (editError) {
    throw new Error(`AI chapter image editing failed: ${editError instanceof Error ? editError.message : String(editError)}`);
  }

  // 7. Upload new image to storage
  const newImageUrl = await storageService.uploadFile(newImageFilename, imageBuffer, 'image/jpeg');

  logger.info('Chapter image edit completed', {
    storyId: story.storyId,
    chapterNumber,
  originalUri: originalImageUri,
  baseImageUri,
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

/**
 * Builds an augmented user request when a reference image is supplied.
 * If no original request is provided (should not happen for AI path per validation), fallback to generic guidance.
 */
function buildUserRequestWithReference(userRequest?: string, userImageUri?: string): string {
  if (!userImageUri) return userRequest || '';
  const referenceNote = 'Use the separately provided user reference image as stylistic and compositional inspiration while preserving key identifiable elements of the original story image. Do not copy verbatim; adapt coherently to existing story context.';
  if (!userRequest || userRequest.trim().length === 0) {
    return referenceNote;
  }
  return `${userRequest}\n\n${referenceNote}`;
}

