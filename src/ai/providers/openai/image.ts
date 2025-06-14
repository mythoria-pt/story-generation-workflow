/**
 * OpenAI Image Generation Service (DALL-E)
 */

import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface OpenAIImageConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIImageService implements IImageGenerationService {
  private apiKey: string;
  private model: string;
  private baseURL: string;

  constructor(config: OpenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'dall-e-3';
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
    
    logger.info('OpenAI Image Service initialized', {
      model: this.model,
      baseURL: this.baseURL
    });
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const response = await fetch(`${this.baseURL}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: options?.model || this.model,
          prompt: prompt,
          n: 1,
          size: this.getSizeString(options?.width, options?.height),
          quality: options?.quality || 'standard',
          style: options?.style || 'vivid',
          response_format: 'b64_json'
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OpenAI Image API error: ${response.status} - ${errorData}`);
      }

      const data = await response.json();
      const imageData = data.data?.[0]?.b64_json;

      if (!imageData) {
        throw new Error('No image generated from OpenAI');
      }

      const buffer = Buffer.from(imageData, 'base64');

      logger.debug('OpenAI image generation completed', {
        promptLength: prompt.length,
        imageSize: buffer.length
      });

      return buffer;
    } catch (error) {
      logger.error('OpenAI image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length
      });
      throw error;
    }
  }

  private getSizeString(width?: number, height?: number): string {
    if (!width && !height) {
      return '1024x1024';
    }
    
    // DALL-E 3 supports specific sizes
    const supportedSizes = ['1024x1024', '1792x1024', '1024x1792'];
    
    if (width && height) {
      const requestedSize = `${width}x${height}`;
      if (supportedSizes.includes(requestedSize)) {
        return requestedSize;
      }
    }
    
    // Default to square format
    return '1024x1024';
  }
}
