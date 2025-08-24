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

// Lazy singleton getter to avoid import-time side effects
let _trackedGatewaySingleton: AIGatewayWithTokenTracking | null = null;
export function getAIGatewayWithTokenTracking(): AIGatewayWithTokenTracking {
  if (!_trackedGatewaySingleton) {
    _trackedGatewaySingleton = AIGatewayWithTokenTracking.fromEnvironment();
  }
  return _trackedGatewaySingleton;
}

// Test-only helper to reset the singleton between tests
export function resetAIGatewayWithTokenTrackingForTests(): void {
  _trackedGatewaySingleton = null;
}

// Re-export the AICallContext interface for convenience
export type { AICallContext } from '@/ai/token-tracking-middleware.js';
