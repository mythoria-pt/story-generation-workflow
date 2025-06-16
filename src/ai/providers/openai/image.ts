/**
 * OpenAI Image Generation Service (DALL-E)
 */

import OpenAI from 'openai';
import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface OpenAIImageConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIImageService implements IImageGenerationService {
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIImageConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL
    });
    this.model = config.model || 'dall-e-3';
    
    logger.info('OpenAI Image Service initialized', {
      model: this.model,
      baseURL: config.baseURL || 'https://api.openai.com/v1'
    });
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      logger.info('OpenAI: Generating image', {
        model: options?.model || this.model,
        promptLength: prompt.length,
        dimensions: this.getSizeString(options?.width, options?.height)
      });

      const response = await this.client.images.generate({
        model: options?.model || this.model,
        prompt: prompt,
        n: 1,
        size: this.getSizeString(options?.width, options?.height) as '1024x1024' | '1792x1024' | '1024x1792',
        quality: (options?.quality as 'standard' | 'hd') || 'standard',
        style: (options?.style as 'vivid' | 'natural') || 'vivid',
        response_format: 'b64_json'
      });      const imageData = response.data?.[0]?.b64_json;

      if (!imageData) {
        throw new Error('No image generated from OpenAI');
      }

      const buffer = Buffer.from(imageData, 'base64');

      logger.info('OpenAI: Image generated successfully', {
        model: options?.model || this.model,
        promptLength: prompt.length,
        imageSize: buffer.length,
        dimensions: this.getSizeString(options?.width, options?.height)
      });

      return buffer;
    } catch (error) {
      logger.error('OpenAI: Image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        model: options?.model || this.model,
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
