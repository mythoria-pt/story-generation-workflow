/**
 * Azure OpenAI Text Generation Service
 */

import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface AzureOpenAITextConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
  apiVersion?: string;
}

export class AzureOpenAITextService implements ITextGenerationService {
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private apiVersion: string;

  constructor(config: AzureOpenAITextConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4';
    this.apiVersion = config.apiVersion || '2024-02-15-preview';
    
    logger.info('Azure OpenAI Text Service initialized', {
      endpoint: this.endpoint,
      model: this.model,
      apiVersion: this.apiVersion
    });
  }

  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      const url = `${this.endpoint}/openai/deployments/${options?.model || this.model}/chat/completions?api-version=${this.apiVersion}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
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
        throw new Error(`Azure OpenAI API error: ${response.status} - ${errorData}`);
      }

      const data = await response.json();
      const result = data.choices?.[0]?.message?.content;

      if (!result) {
        throw new Error('No text generated from Azure OpenAI');
      }

      logger.debug('Azure OpenAI text generation completed', {
        promptLength: prompt.length,
        responseLength: result.length,
        tokensUsed: data.usage
      });

      return result;
    } catch (error) {
      logger.error('Azure OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length
      });
      throw error;
    }
  }
}
