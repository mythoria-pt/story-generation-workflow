/**
 * AI Token Usage Middleware
 * Intercepts AI calls and adds token usage tracking without modifying existing services
 */

import { ITextGenerationService, IImageGenerationService, TextGenerationOptions, ImageGenerationOptions } from '@/ai/interfaces.js';
import { tokenUsageTrackingService } from '@/services/token-usage-tracking.js';
import { logger } from '@/config/logger.js';

export interface AICallContext {
  authorId: string;
  storyId: string;
  action: 'story_structure' | 'story_outline' | 'chapter_writing' | 'image_generation' | 
          'story_review' | 'character_generation' | 'story_enhancement' | 'audio_generation' | 'content_validation' | 'image_edit' | 'test';
}

/**
 * Token Usage Middleware for Text Generation
 */
export class TextGenerationMiddleware implements ITextGenerationService {
  constructor(
    private baseService: ITextGenerationService,
    private context: AICallContext
  ) {}

  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    const startTime = Date.now();
    
    try {
      logger.info('Starting text generation with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        model: options?.model
      });

      // Make the actual AI call
      const result = await this.baseService.complete(prompt, options);
      
      // Calculate processing time
      const processingTimeMs = Date.now() - startTime;
      
      // Estimate token usage (rough approximation)
      const tokenUsage = this.estimateTokenUsage(prompt, result);
      
      // Record the usage asynchronously to avoid blocking the response
    const sanitizedOptions = this.sanitizeOptions(options);
    this.recordUsageAsync({
        authorId: this.context.authorId,
        storyId: this.context.storyId,
        action: this.context.action,
        aiModel: this.determineModel(options),
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        inputPromptJson: {
          prompt,
      options: sanitizedOptions,
          timestamp: new Date().toISOString(),
          processingTimeMs,
          resultLength: result.length
        }
      });

      logger.info('Text generation completed with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        resultLength: result.length,
        processingTimeMs,
        estimatedInputTokens: tokenUsage.inputTokens,
        estimatedOutputTokens: tokenUsage.outputTokens
      });

      return result;
    } catch (error) {
      logger.error('Text generation failed with token tracking', {
        error: error instanceof Error ? error.message : String(error),
        context: this.context,
        promptLength: prompt.length,
        processingTimeMs: Date.now() - startTime
      });
      throw error;
    }
  }

  /**
   * Remove/condense large binary fields from options before storing/logging
   */
  private sanitizeOptions(options?: TextGenerationOptions): Record<string, unknown> {
    if (!options) return {};
    const { mediaParts, ...rest } = options as any;
    const sanitized: Record<string, unknown> = { ...rest };
    if (Array.isArray(mediaParts)) {
      sanitized.mediaParts = mediaParts.map((mp: any) => {
        const isString = typeof mp?.data === 'string';
        let sizeBytes = 0;
        if (isString) {
          // If data URL/base64 string, estimate decoded size
          const str: string = mp.data;
          const b64 = /^data:[^;]+;base64,(.*)$/.exec(str)?.[1] || str;
          try { sizeBytes = Buffer.byteLength(Buffer.from(b64, 'base64')); } catch { sizeBytes = b64.length; }
        } else if (mp?.data && typeof mp.data.length === 'number') {
          sizeBytes = mp.data.length;
        }
        return { mimeType: mp?.mimeType, sizeBytes };
      });
    }
    return sanitized;
  }

  async initializeContext?(contextId: string, systemPrompt: string, previousContent?: string[]): Promise<void> {
    if (this.baseService.initializeContext) {
      return this.baseService.initializeContext(contextId, systemPrompt, previousContent);
    }
  }

  async clearContext?(contextId: string): Promise<void> {
    if (this.baseService.clearContext) {
      return this.baseService.clearContext(contextId);
    }
  }

  /**
   * Estimate token usage based on text length
   * This is a rough approximation: 1 token ≈ 4 characters for English text
   */
  private estimateTokenUsage(prompt: string, result: string): {
    inputTokens: number;
    outputTokens: number;
  } {
    return {
      inputTokens: Math.ceil(prompt.length / 4),
      outputTokens: Math.ceil(result.length / 4)
    };
  }

  /**
   * Determine the AI model being used
   */
  private determineModel(options?: TextGenerationOptions): string {
    if (options?.model) {
      return options.model;
    }

    // Fallback to environment configuration
    const provider = process.env.TEXT_PROVIDER || 'vertex';
    if (provider === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-4o';
    } else if (provider === 'vertex') {
      return process.env.VERTEX_AI_MODEL_ID || 'gemini-2.0-flash';
    }
    
    return 'unknown';
  }

  /**
   * Record usage asynchronously to avoid blocking the response
   */
  private recordUsageAsync(usageData: Parameters<typeof tokenUsageTrackingService.recordUsage>[0]): void {
    // Use setImmediate to record usage asynchronously
    setImmediate(async () => {
      try {
        await tokenUsageTrackingService.recordUsage(usageData);
      } catch (error) {
        logger.error('Failed to record token usage asynchronously', {
          error: error instanceof Error ? error.message : String(error),
          usageData: { ...usageData, inputPromptJson: 'REDACTED' }
        });
      }
    });
  }
}

/**
 * Token Usage Middleware for Image Generation
 */
export class ImageGenerationMiddleware implements IImageGenerationService {
  constructor(
    private baseService: IImageGenerationService,
    private context: AICallContext
  ) {}

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    const startTime = Date.now();
    
    try {
      logger.info('Starting image generation with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        model: options?.model
      });

      // Make the actual AI call
      const result = await this.baseService.generate(prompt, options);
      
      // Calculate processing time
      const processingTimeMs = Date.now() - startTime;
      
      // For image generation, we use a different approach for "token" calculation
      // Input tokens are based on prompt length, output tokens represent generation cost
      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = 1000; // Fixed cost per image generation
      
      // Record the usage asynchronously
      this.recordUsageAsync({
        authorId: this.context.authorId,
        storyId: this.context.storyId,
        action: this.context.action,
        aiModel: this.determineModel(options),
        inputTokens,
        outputTokens,
        inputPromptJson: {
          prompt,
          options: options || {},
          timestamp: new Date().toISOString(),
          processingTimeMs,
          imageSizeBytes: result.length
        }
      });

      logger.info('Image generation completed with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        imageSizeBytes: result.length,
        processingTimeMs,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens
      });

      return result;
    } catch (error) {
      logger.error('Image generation failed with token tracking', {
        error: error instanceof Error ? error.message : String(error),
        context: this.context,
        promptLength: prompt.length,
        processingTimeMs: Date.now() - startTime
      });
      throw error;
    }
  }

  /**
   * Edit an existing image with token tracking
   */  async edit(prompt: string, originalImage: Buffer, options?: ImageGenerationOptions): Promise<Buffer> {
    const startTime = Date.now();
    
    try {
      logger.info('MIDDLEWARE: Starting image editing with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        model: options?.model,
        hasEditMethod: typeof this.baseService.edit !== 'undefined'
      });

      // Check if the base service supports editing
      if (!this.baseService.edit) {
        throw new Error('Base image service does not support editing');
      }

      // Make the actual AI call
      const result = await this.baseService.edit(prompt, originalImage, options);
      
      // Calculate processing time
      const processingTimeMs = Date.now() - startTime;
      
      // For image editing, we use a different approach for "token" calculation
      // Input tokens are based on prompt length + original image size, output tokens represent generation cost
      const inputTokens = Math.ceil(prompt.length / 4) + Math.ceil(originalImage.length / 1000); // Add image size factor
      const outputTokens = 1500; // Higher cost for image editing vs generation
      
      // Record the usage asynchronously
      this.recordUsageAsync({
        authorId: this.context.authorId,
        storyId: this.context.storyId,
        action: this.context.action,
        aiModel: this.determineModel(options),
        inputTokens,
        outputTokens,
        inputPromptJson: {
          prompt,
          options: options || {},
          originalImageSize: originalImage.length,
          timestamp: new Date().toISOString(),
          processingTimeMs,
          editedImageSizeBytes: result.length
        }
      });

      logger.info('Image editing completed with token tracking', {
        context: this.context,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        editedImageSizeBytes: result.length,
        processingTimeMs,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens
      });

      return result;
    } catch (error) {
      logger.error('Image editing failed with token tracking', {
        error: error instanceof Error ? error.message : String(error),
        context: this.context,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        processingTimeMs: Date.now() - startTime
      });
      throw error;
    }
  }

  /**
   * Determine the AI model being used for image generation
   */
  private determineModel(options?: ImageGenerationOptions): string {
    if (options?.model) {
      return options.model;
    }

    // Fallback to environment configuration
    const provider = process.env.IMAGE_PROVIDER || 'vertex';
    if (provider === 'openai') {
      return process.env.OPENAI_IMAGE_MODEL || 'gpt-4.1';
    } else if (provider === 'vertex') {
      return 'imagen-3.0-generate-001';
    }
    
    return 'unknown';
  }

  /**
   * Record usage asynchronously to avoid blocking the response
   */
  private recordUsageAsync(usageData: Parameters<typeof tokenUsageTrackingService.recordUsage>[0]): void {
    setImmediate(async () => {
      try {
        await tokenUsageTrackingService.recordUsage(usageData);
      } catch (error) {
        logger.error('Failed to record image generation usage asynchronously', {
          error: error instanceof Error ? error.message : String(error),
          usageData: { ...usageData, inputPromptJson: 'REDACTED' }
        });
      }
    });
  }
}

/**
 * Factory function to create AI services with token tracking middleware
 */
export function withTokenTracking<T extends ITextGenerationService | IImageGenerationService>(
  service: T,
  context: AICallContext
): T {
  if ('complete' in service) {
    return new TextGenerationMiddleware(service as ITextGenerationService, context) as unknown as T;
  } else if ('generate' in service) {
    return new ImageGenerationMiddleware(service as IImageGenerationService, context) as unknown as T;
  }
  
  throw new Error('Unsupported service type for token tracking');
}
