/**
 * Enhanced AI Provider Interfaces with Token Usage Support
 * Extended interfaces to support token usage reporting
 */

import { TextGenerationOptions, ImageGenerationOptions } from './interfaces.js';

export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TextGenerationResult {
  content: string;
  usage: TokenUsageInfo;
  model: string;
  finishReason?: string;
}

export interface ImageGenerationResult {
  image: Buffer;
  usage: TokenUsageInfo;
  model: string;
  revisedPrompt?: string;
}

export interface IEnhancedTextGenerationService {
  /**
   * Complete a text generation request with usage tracking
   * @param prompt The input prompt
   * @param options Additional generation options
   */
  completeWithUsage(prompt: string, options?: TextGenerationOptions): Promise<TextGenerationResult>;

  /**
   * Legacy complete method for backward compatibility
   */
  complete(prompt: string, options?: TextGenerationOptions): Promise<string>;
}

export interface IEnhancedImageGenerationService {
  /**
   * Generate an image with usage tracking
   * @param prompt The image description prompt
   * @param options Additional generation options
   */
  generateWithUsage(
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult>;

  /**
   * Legacy generate method for backward compatibility
   */
  generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer>;
}
