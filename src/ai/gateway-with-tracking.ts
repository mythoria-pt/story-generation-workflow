/**
 * AI Gateway Token Tracking Wrapper (current version)
 * Uses token-tracking middleware for both text and image services.
 */

import { AIGateway } from '@/ai/gateway.js';
import { ITextGenerationService, IImageGenerationService } from '@/ai/interfaces.js';
import { FallbackImageGenerationService } from '@/ai/fallback-image-service.js';
import { OpenAIImageService } from '@/ai/providers/openai/image.js';
import { withTokenTracking, AICallContext } from '@/ai/token-tracking-middleware.js';

export class AIGatewayWithTokenTracking {
  private aiGateway: AIGateway;

  constructor(aiGateway: AIGateway) {
    this.aiGateway = aiGateway;
  }

  getTextService(context: AICallContext): ITextGenerationService {
    const baseService = this.aiGateway.getTextService();
    return withTokenTracking(baseService, context);
  }

  getImageService(context: AICallContext): IImageGenerationService {
    let service: IImageGenerationService = this.aiGateway.getImageService();

    // Conditional fallback: if primary provider is google-genai and OpenAI credentials are present
    // we wrap the base service with a fallback to OpenAI for safety blocks.
    const primaryProvider = process.env.IMAGE_PROVIDER || 'google-genai';
    const openaiKey = process.env.OPENAI_API_KEY;
    if (primaryProvider === 'google-genai' && openaiKey) {
      try {
        const baseModel =
          process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.2';
        const imageToolModel = process.env.OPENAI_IMAGE_TOOL_MODEL || 'gpt-image-1.5';
        const fallback = new OpenAIImageService({
          apiKey: openaiKey,
          model: baseModel,
          imageModel: imageToolModel,
        });
        service = new FallbackImageGenerationService({
          primary: service,
          fallback,
          primaryName: 'google-genai',
          fallbackName: 'openai',
        });
      } catch (e) {
        // If fallback construction fails, log and proceed without fallback.
        console.warn(
          'Failed to initialize fallback image service (OpenAI). Proceeding without fallback.',
          e,
        );
      }
    }

    return withTokenTracking(service, context);
  }

  static fromEnvironment(): AIGatewayWithTokenTracking {
    const baseGateway = AIGateway.fromEnvironment();
    return new AIGatewayWithTokenTracking(baseGateway);
  }
}

let _trackedGatewaySingleton: AIGatewayWithTokenTracking | null = null;
export function getAIGatewayWithTokenTracking(): AIGatewayWithTokenTracking {
  if (!_trackedGatewaySingleton) {
    _trackedGatewaySingleton = AIGatewayWithTokenTracking.fromEnvironment();
  }
  return _trackedGatewaySingleton;
}

export function resetAIGatewayWithTokenTrackingForTests(): void {
  _trackedGatewaySingleton = null;
}

export type { AICallContext } from '@/ai/token-tracking-middleware.js';
