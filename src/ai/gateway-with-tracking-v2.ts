/**
 * AI Gateway Token Tracking Wrapper
 * Extends the AI Gateway with automatic token usage tracking using middleware
 */

import { AIGateway } from '@/ai/gateway.js';
import { ITextGenerationService, IImageGenerationService } from '@/ai/interfaces.js';
import { withTokenTracking, AICallContext } from '@/ai/token-tracking-middleware.js';

/**
 * AI Gateway with Token Tracking
 * Wraps the original AI Gateway to add automatic token usage tracking
 */
export class AIGatewayWithTokenTracking {
  private aiGateway: AIGateway;

  constructor(aiGateway: AIGateway) {
    this.aiGateway = aiGateway;
  }

  /**
   * Get text service with token tracking
   */
  getTextService(context: AICallContext): ITextGenerationService {
    const baseService = this.aiGateway.getTextService();
    return withTokenTracking(baseService, context);
  }

  /**
   * Get image service with token tracking
   */
  getImageService(context: AICallContext): IImageGenerationService {
    const baseService = this.aiGateway.getImageService();
    return withTokenTracking(baseService, context);
  }

  /**
   * Create AI Gateway with token tracking from environment
   */
  static fromEnvironment(): AIGatewayWithTokenTracking {
    const baseGateway = AIGateway.fromEnvironment();
    return new AIGatewayWithTokenTracking(baseGateway);
  }
}

// Export a singleton instance for convenience
export const aiGatewayWithTokenTracking = AIGatewayWithTokenTracking.fromEnvironment();

// Re-export the AICallContext interface for convenience
export type { AICallContext } from '@/ai/token-tracking-middleware.js';
