/**
 * AI Gateway Token Tracking Wrapper (current version)
 * Uses token-tracking middleware for both text and image services.
 */

import { AIGateway } from '@/ai/gateway.js';
import { ITextGenerationService, IImageGenerationService } from '@/ai/interfaces.js';
import { FallbackImageGenerationService } from '@/ai/fallback-image-service.js';
import { FallbackTextGenerationService } from '@/ai/fallback-text-service.js';
import { OpenAIImageService } from '@/ai/providers/openai/image.js';
import { OpenAITextService } from '@/ai/providers/openai/text.js';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import { withTokenTracking, AICallContext } from '@/ai/token-tracking-middleware.js';

export class AIGatewayWithTokenTracking {
  private aiGateway: AIGateway;
  private cachedGooglePrimaryFallbackTextService: ITextGenerationService | null = null;
  private cachedOpenAIPrimaryFallbackTextService: ITextGenerationService | null = null;

  constructor(aiGateway: AIGateway) {
    this.aiGateway = aiGateway;
  }

  getTextService(context: AICallContext): ITextGenerationService {
    let service: ITextGenerationService = this.aiGateway.getTextService();

    const primaryProvider = process.env.TEXT_PROVIDER || 'google-genai';
    const openaiKey = process.env.OPENAI_API_KEY;
    const googleKey = process.env.GOOGLE_GENAI_API_KEY;

    if (primaryProvider === 'google-genai' && openaiKey) {
      if (this.cachedGooglePrimaryFallbackTextService) {
        return withTokenTracking(this.cachedGooglePrimaryFallbackTextService, context);
      }

      try {
        const fallbackModel =
          process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
        const fallback = new OpenAITextService({
          apiKey: openaiKey,
          model: fallbackModel,
        });

        service = new FallbackTextGenerationService({
          primary: service,
          fallback,
          primaryName: 'google-genai',
          fallbackName: 'openai',
          fallbackModel,
        });
        this.cachedGooglePrimaryFallbackTextService = service;
      } catch (e) {
        console.warn(
          'Failed to initialize fallback text service (OpenAI). Proceeding without fallback.',
          e,
        );
      }
    }

    if (primaryProvider === 'openai' && googleKey) {
      if (this.cachedOpenAIPrimaryFallbackTextService) {
        return withTokenTracking(this.cachedOpenAIPrimaryFallbackTextService, context);
      }

      try {
        const fallbackModel = process.env.GOOGLE_GENAI_MODEL || 'gemini-2.5-flash';
        const fallback = new GoogleGenAITextService({
          apiKey: googleKey,
          model: fallbackModel,
        });

        service = new FallbackTextGenerationService({
          primary: service,
          fallback,
          primaryName: 'openai',
          fallbackName: 'google-genai',
          fallbackModel,
        });
        this.cachedOpenAIPrimaryFallbackTextService = service;
      } catch (e) {
        console.warn(
          'Failed to initialize fallback text service (Google GenAI). Proceeding without fallback.',
          e,
        );
      }
    }

    return withTokenTracking(service, context);
  }

  /**
   * Build a tracked text service for an explicitly requested provider
   * ('google-genai' | 'openai'). Used by features (e.g. image analysis) that
   * select their provider independently of TEXT_PROVIDER. Falls back to the
   * default text service if the requested provider's credentials are missing.
   */
  getTextServiceForProvider(provider: string, context: AICallContext): ITextGenerationService {
    const normalized = (provider || 'google-genai').toLowerCase();

    if (normalized === 'openai') {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        console.warn(
          `OpenAI API key missing; falling back to default text service for provider "${provider}".`,
        );
        return this.getTextService(context);
      }
      const model = process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
      return withTokenTracking(new OpenAITextService({ apiKey: openaiKey, model }), context);
    }

    // Default: google-genai
    const googleKey = process.env.GOOGLE_GENAI_API_KEY;
    if (!googleKey) {
      console.warn(
        `Google GenAI API key missing; falling back to default text service for provider "${provider}".`,
      );
      return this.getTextService(context);
    }
    const model = process.env.GOOGLE_GENAI_MODEL || 'gemini-3.5-flash';
    return withTokenTracking(new GoogleGenAITextService({ apiKey: googleKey, model }), context);
  }

  /**
   * Resolve the text (vision-language) service used for image analysis.
   * Provider is chosen from IMAGE_ANALYZER_PROVIDER, then IMAGE_PROVIDER, then
   * 'google-genai'. The OpenAI text service does not yet support multimodal
   * input, so an 'openai' selection falls back to google-genai (when available).
   */
  getImageAnalysisTextService(context: AICallContext): {
    service: ITextGenerationService;
    provider: string;
  } {
    const requested = (
      process.env.IMAGE_ANALYZER_PROVIDER ||
      process.env.IMAGE_PROVIDER ||
      'google-genai'
    ).toLowerCase();

    let provider = requested;
    if (provider === 'openai' && process.env.GOOGLE_GENAI_API_KEY) {
      console.warn(
        'IMAGE_ANALYZER_PROVIDER=openai is not supported for image analysis (no multimodal support); falling back to google-genai.',
      );
      provider = 'google-genai';
    }

    return { service: this.getTextServiceForProvider(provider, context), provider };
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
          process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
        const imageToolModel = process.env.OPENAI_IMAGE_TOOL_MODEL || 'gpt-image-2';
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
