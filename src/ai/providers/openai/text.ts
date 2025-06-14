/**
 * OpenAI Text Generation Service
 */

import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface OpenAITextConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAITextService implements ITextGenerationService {
  private apiKey: string;
  private model: string;
  private baseURL: string;

  constructor(config: OpenAITextConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4';
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
    
    logger.info('OpenAI Text Service initialized', {
      model: this.model,
      baseURL: this.baseURL
    });
  }

  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: options?.model || this.model,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
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
      const result = data.choices?.[0]?.message?.content;

      if (!result) {
        throw new Error('No text generated from OpenAI');
      }

      logger.debug('OpenAI text generation completed', {
        promptLength: prompt.length,
        responseLength: result.length,
        tokensUsed: data.usage
      });

      return result;
    } catch (error) {
      logger.error('OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length
      });
      throw error;
    }
  }
}
