/**
 * Stability AI Image Generation Service
 */

import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface StabilityImageConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class StabilityImageService implements IImageGenerationService {
  private apiKey: string;
  private model: string;
  private baseURL: string;

  constructor(config: StabilityImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'stable-diffusion-xl-1024-v1-0';
    this.baseURL = config.baseURL || 'https://api.stability.ai/v1';
    
    logger.info('Stability AI Image Service initialized', {
      model: this.model,
      baseURL: this.baseURL
    });
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const response = await fetch(`${this.baseURL}/generation/${this.model}/text-to-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text_prompts: [
            {
              text: prompt,
              weight: 1
            }
          ],
          width: options?.width || 1024,
          height: options?.height || 1024,
          steps: options?.steps || 30,
          cfg_scale: 7,
          samples: 1
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Stability AI API error: ${response.status} - ${errorData}`);
      }

      const data = await response.json();
      const imageData = data.artifacts?.[0]?.base64;

      if (!imageData) {
        throw new Error('No image generated from Stability AI');
      }

      const buffer = Buffer.from(imageData, 'base64');

      logger.debug('Stability AI image generation completed', {
        promptLength: prompt.length,
        imageSize: buffer.length
      });

      return buffer;
    } catch (error) {
      logger.error('Stability AI image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length
      });
      throw error;
    }
  }
}
