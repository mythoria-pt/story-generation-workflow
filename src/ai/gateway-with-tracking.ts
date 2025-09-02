/**
 * AI Gateway Token Tracking Wrapper
 * Extends the AI Gateway with automatic token usage tracking
 */

import { AIGateway } from "@/ai/gateway.js";
import {
  ITextGenerationService,
  IImageGenerationService,
  TextGenerationOptions,
  ImageGenerationOptions,
} from "@/ai/interfaces.js";
import { tokenUsageTrackingService } from "@/services/token-usage-tracking.js";
import { logger } from "@/config/logger.js";

export interface AICallContext {
  authorId: string;
  storyId: string;
  action:
    | "story_structure"
    | "story_outline"
    | "chapter_writing"
    | "image_generation"
    | "story_review"
    | "character_generation"
    | "story_enhancement"
    | "audio_generation"
    | "content_validation"
    | "test";
}

/**
 * Text Generation Service Wrapper with Token Tracking
 */
class TextGenerationServiceWrapper implements ITextGenerationService {
  constructor(
    private baseService: ITextGenerationService,
    private context: AICallContext,
  ) {}

  async complete(
    prompt: string,
    options?: TextGenerationOptions,
  ): Promise<string> {
    const startTime = Date.now();

    try {
      // Make the actual AI call
      const result = await this.baseService.complete(prompt, options);

      // Extract token usage information
      const tokenUsage = this.extractTokenUsage(prompt, result, options);

      // Record the usage
      await tokenUsageTrackingService.recordUsage({
        authorId: this.context.authorId,
        storyId: this.context.storyId,
        action: this.context.action,
        aiModel: options?.model || this.getDefaultModel(),
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        inputPromptJson: {
          prompt,
          options: options || {},
          timestamp: new Date().toISOString(),
          processingTimeMs: Date.now() - startTime,
        },
      });

      return result;
    } catch (error) {
      logger.error("Text generation failed with token tracking", {
        error: error instanceof Error ? error.message : String(error),
        context: this.context,
        promptLength: prompt.length,
      });
      throw error;
    }
  }

  async initializeContext?(
    contextId: string,
    systemPrompt: string,
    previousContent?: string[],
  ): Promise<void> {
    if (this.baseService.initializeContext) {
      return this.baseService.initializeContext(
        contextId,
        systemPrompt,
        previousContent,
      );
    }
  }

  async clearContext?(contextId: string): Promise<void> {
    if (this.baseService.clearContext) {
      return this.baseService.clearContext(contextId);
    }
  }

  /**
   * Extract token usage from the AI call
   * Since we don't have direct access to token counts from some providers,
   * we estimate based on text length using a rough approximation
   */
  private extractTokenUsage(
    prompt: string,
    result: string,
    _options?: TextGenerationOptions,
  ): {
    inputTokens: number;
    outputTokens: number;
  } {
    // Rough estimation: 1 token ≈ 0.75 words ≈ 4 characters (English)
    // This is an approximation; actual token counts vary by model and tokenizer
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(result.length / 4);

    return {
      inputTokens,
      outputTokens,
    };
  }

  private getDefaultModel(): string {
    // Try to determine the model from common patterns
    if (process.env.TEXT_PROVIDER === "openai") {
      return process.env.OPENAI_TEXT_MODEL || "gpt-4o";
    } else if (process.env.TEXT_PROVIDER === "google-genai") {
      return process.env.GOOGLE_GENAI_MODEL || "gemini-2.5-flash";
    }
    return "unknown";
  }
}

/**
 * Image Generation Service Wrapper with Token Tracking
 */
class ImageGenerationServiceWrapper implements IImageGenerationService {
  constructor(
    private baseService: IImageGenerationService,
    private context: AICallContext,
  ) {}

  async generate(
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<Buffer> {
    const startTime = Date.now();

    try {
      // Make the actual AI call
      const result = await this.baseService.generate(prompt, options);

      // For image generation, we estimate token usage differently
      // Input tokens are based on prompt length
      // Output "tokens" represent the computational cost (we use a fixed value per image)
      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = 1000; // Fixed cost per image generation

      // Record the usage
      await tokenUsageTrackingService.recordUsage({
        authorId: this.context.authorId,
        storyId: this.context.storyId,
        action: this.context.action,
        aiModel: options?.model || this.getDefaultModel(),
        inputTokens,
        outputTokens,
        inputPromptJson: {
          prompt,
          options: options || {},
          timestamp: new Date().toISOString(),
          processingTimeMs: Date.now() - startTime,
          imageSizeBytes: result.length,
        },
      });

      return result;
    } catch (error) {
      logger.error("Image generation failed with token tracking", {
        error: error instanceof Error ? error.message : String(error),
        context: this.context,
        promptLength: prompt.length,
      });
      throw error;
    }
  }

  private getDefaultModel(): string {
    // Try to determine the model from common patterns
    if (process.env.IMAGE_PROVIDER === "openai") {
      return process.env.OPENAI_IMAGE_MODEL || "gpt-5";
    } else if (process.env.IMAGE_PROVIDER === "google-genai") {
      return (
        process.env.GOOGLE_GENAI_IMAGE_MODEL || "gemini-2.5-flash-image-preview"
      );
    }
    return "unknown";
  }
}

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
    return new TextGenerationServiceWrapper(baseService, context);
  }

  /**
   * Get image service with token tracking
   */
  getImageService(context: AICallContext): IImageGenerationService {
    const baseService = this.aiGateway.getImageService();
    return new ImageGenerationServiceWrapper(baseService, context);
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
