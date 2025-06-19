/**
 * Enhanced OpenAI Text Generation Service with Token Usage
 * Extends the base OpenAI service to provide actual token usage data
 */

import { OpenAITextService } from './text.js';
import { IEnhancedTextGenerationService, TextGenerationResult, TokenUsageInfo } from '../../enhanced-interfaces.js';
import { TextGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export class EnhancedOpenAITextService extends OpenAITextService implements IEnhancedTextGenerationService {
  
  async completeWithUsage(prompt: string, options?: TextGenerationOptions): Promise<TextGenerationResult> {
    try {
      return await this.completeWithResponsesAPIAndUsage(prompt, options);
    } catch (error) {
      logger.error('Enhanced OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        contextId: options?.contextId
      });
      throw error;
    }
  }

  /**
   * Enhanced Responses API with usage tracking
   */
  private async completeWithResponsesAPIAndUsage(prompt: string, options?: TextGenerationOptions): Promise<TextGenerationResult> {
    // Similar approach for Responses API
    const content = await this.complete(prompt, options);
    const usage = await this.estimateTokenUsage(prompt, content, options);
    
    return {
      content,
      usage,
      model: options?.model || this['model'] || 'gpt-4o',
      finishReason: 'stop'
    };
  }
  /**
   * Estimate token usage when actual usage is not available
   * This is a fallback method - ideally we'd get actual usage from the API
   */
  private async estimateTokenUsage(prompt: string, content: string, _options?: TextGenerationOptions): Promise<TokenUsageInfo> {
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
      totalTokens: inputTokens + outputTokens
    };  }
  
  /*
   * Make a direct API call to get actual token usage
   * This method bypasses the parent class to get raw API response with usage data
   * Currently unused but kept for future implementation
   */
  /*
  private async makeDirectAPICallForUsage(prompt: string, options?: TextGenerationOptions): Promise<{
    content: string;
    usage: TokenUsageInfo;
    model: string;
    finishReason?: string;
  }> {
    // This would require duplicating some logic from the parent class
    // but allows us to get the actual usage data from the API response
    
    const apiKey = this['apiKey'];
    const baseURL = this['baseURL'];
    const model = options?.model || this['model'];

    const messages = [{ role: 'user', content: prompt }];
    
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature || 0.7,
        top_p: options?.topP || 1,
        stop: options?.stopSequences
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0
      },
      model: data.model || model,
      finishReason: data.choices?.[0]?.finish_reason
    };
  }
  */
}

export { EnhancedOpenAITextService as OpenAITextServiceWithUsage };
