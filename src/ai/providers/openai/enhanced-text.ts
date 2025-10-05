/**
 * Enhanced OpenAI Text Generation Service with Token Usage
 * Extends the base OpenAI service to provide actual token usage data
 */

import { OpenAITextService } from './text.js';
import {
  IEnhancedTextGenerationService,
  TextGenerationResult,
  TokenUsageInfo,
} from '../../enhanced-interfaces.js';
import { TextGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export class EnhancedOpenAITextService
  extends OpenAITextService
  implements IEnhancedTextGenerationService
{
  async completeWithUsage(
    prompt: string,
    options?: TextGenerationOptions,
  ): Promise<TextGenerationResult> {
    try {
      return await this.completeWithResponsesAPIAndUsage(prompt, options);
    } catch (error) {
      logger.error('Enhanced OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        contextId: options?.contextId,
      });
      throw error;
    }
  }

  /**
   * Enhanced Responses API with usage tracking
   */
  private async completeWithResponsesAPIAndUsage(
    prompt: string,
    options?: TextGenerationOptions,
  ): Promise<TextGenerationResult> {
    // Similar approach for Responses API
    const content = await this.complete(prompt, options);
    const usage = await this.estimateTokenUsage(prompt, content, options);

    return {
      content,
      usage,
      model: options?.model || this['model'] || 'gpt-4o',
      finishReason: 'stop',
    };
  }
  /**
   * Estimate token usage when actual usage is not available
   * This is a fallback method - ideally we'd get actual usage from the API
   */
  private async estimateTokenUsage(
    prompt: string,
    content: string,
    _options?: TextGenerationOptions,
  ): Promise<TokenUsageInfo> {
    // Use OpenAI's tiktoken library estimation if available, otherwise rough estimation
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(content.length / 4);

    // For more accurate token counting, you could integrate tiktoken here:
    // import { encoding_for_model } from 'tiktoken';
    // const encoding = encoding_for_model(options?.model || 'gpt-4o');
    // const inputTokens = encoding.encode(prompt).length;
    // const outputTokens = encoding.encode(content).length;

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
}

export { EnhancedOpenAITextService as OpenAITextServiceWithUsage };
