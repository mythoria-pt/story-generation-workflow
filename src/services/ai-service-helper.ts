/**
 * AI Service Helper with Token Tracking
 * Provides easy access to AI services with automatic token usage tracking
 */

import { AIGatewayWithTokenTracking, AICallContext } from '@/ai/gateway-with-tracking-v2.js';
import { ITextGenerationService, IImageGenerationService, TextGenerationOptions, ImageGenerationOptions } from '@/ai/interfaces.js';
import { logger } from '@/config/logger.js';

export class AIServiceHelper {
  private aiGateway: AIGatewayWithTokenTracking;

  constructor() {
    this.aiGateway = AIGatewayWithTokenTracking.fromEnvironment();
  }

  /**
   * Get text generation service with token tracking
   */
  getTextService(context: AICallContext): ITextGenerationService {
    return this.aiGateway.getTextService(context);
  }

  /**
   * Get image generation service with token tracking
   */
  getImageService(context: AICallContext): IImageGenerationService {
    return this.aiGateway.getImageService(context);
  }

  /**
   * Convenience method for text generation with automatic context handling
   */
  async generateText(
    prompt: string,
    context: AICallContext,
    options?: TextGenerationOptions
  ): Promise<string> {
    try {
      const textService = this.getTextService(context);
      return await textService.complete(prompt, options);
    } catch (error) {
      logger.error('Text generation failed in AI service helper', {
        error: error instanceof Error ? error.message : String(error),
        context,
        promptLength: prompt.length
      });
      throw error;
    }
  }

  /**
   * Convenience method for image generation with automatic context handling
   */
  async generateImage(
    prompt: string,
    context: AICallContext,
    options?: ImageGenerationOptions
  ): Promise<Buffer> {
    try {
      const imageService = this.getImageService(context);
      return await imageService.generate(prompt, options);
    } catch (error) {
      logger.error('Image generation failed in AI service helper', {
        error: error instanceof Error ? error.message : String(error),
        context,
        promptLength: prompt.length
      });
      throw error;
    }
  }

  /**
   * Create a context object for AI calls
   */
  createContext(
    authorId: string,
    storyId: string,
    action: AICallContext['action']
  ): AICallContext {
    return {
      authorId,
      storyId,
      action
    };
  }
}

// Export a singleton instance
export const aiServiceHelper = new AIServiceHelper();
