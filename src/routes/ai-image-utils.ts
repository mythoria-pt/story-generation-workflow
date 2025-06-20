import { z } from 'zod';

// Schema for image generation requests
export const ImageRequestSchema = z.object({
  prompt: z.string().min(1),
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
  chapterNumber: z.number().int().positive().optional(),
  imageType: z.enum(['front_cover', 'back_cover', 'chapter']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  style: z.enum(['vivid', 'natural']).optional()
});

export type ImageRequest = z.infer<typeof ImageRequestSchema>;

/**
 * Validate and parse the image generation request body.
 */
export function validateImageRequest(data: unknown): ImageRequest {
  return ImageRequestSchema.parse(data);
}

/**
 * Generate a filename for an image based on story context and type.
 */
export function generateImageFilename(params: {
  storyId: string;
  imageType?: 'front_cover' | 'back_cover' | 'chapter';
  chapterNumber?: number;
  timestamp?: string;
}): string {
  const { storyId, imageType, chapterNumber } = params;
  const timestamp = params.timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');

  if (imageType === 'front_cover') {
    return `${storyId}/images/frontcover_v001_${timestamp}.jpg`;
  }
  if (imageType === 'back_cover') {
    return `${storyId}/images/backcover_v001_${timestamp}.jpg`;
  }
  if (chapterNumber) {
    return `${storyId}/images/chapter_${chapterNumber}_v001_${timestamp}.jpg`;
  }
  return `${storyId}/images/image_v001_${timestamp}.jpg`;
}

/**
 * Format an error object with request context for logging and responses.
 */
export function formatImageError(error: unknown, reqData: Partial<ImageRequest>, currentStep: string): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    name: error instanceof Error ? error.name : undefined,
    storyId: reqData.storyId,
    runId: reqData.runId,
    chapterNumber: reqData.chapterNumber,
    timestamp: new Date().toISOString(),
    currentStep,
    requestDetails: {
      promptLength: reqData.prompt?.length,
      dimensions: reqData.width && reqData.height ? `${reqData.width}x${reqData.height}` : 'default',
      style: reqData.style
    }
  };
}

