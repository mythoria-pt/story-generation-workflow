/**
 * OpenAI Image Generation Service using Responses API
 */

import OpenAI from 'openai';
import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxRetries?: number;
}

export class OpenAIImageService implements IImageGenerationService {
  private client: OpenAI;
  private model: string;
  // private maxRetries: number; // Will be used in future retry logic
  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || 'gpt-4.1';
    // maxRetries will be used in future retry logic
    // this.maxRetries = config.maxRetries || 3;
  }async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const env = getEnvironment();
      const quality = env.OPENAI_IMAGE_QUALITY || 'low';
      
      logger.info('OpenAI: Generating image with Responses API', {
        model: this.model,
        promptLength: prompt.length,
        dimensions: this.getSizeString(options?.width, options?.height),
        quality
      });

      // Ensure size is valid for the API
      const size = this.getSizeString(options?.width, options?.height);
      const validSizes = ['1024x1024', '1024x1536', '1536x1024'];
      const finalSize = validSizes.includes(size) ? size as '1024x1024' | '1024x1536' | '1536x1024' : '1024x1024';

      // Ensure quality is valid for the API
      const validQualities = ['low', 'high', 'medium', 'auto'];
      const finalQuality = validQualities.includes(quality) ? quality as 'low' | 'high' | 'medium' | 'auto' : 'low';

      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            "role": "system",
            "content": [
              {
                "type": "input_text",
                "text": "This image is the cover of a book, title {{bookTitle}}.\nUse the style "
              }
            ]
          },
          {
            "role": "user",
            "content": [
              {
                "type": "input_text",
                "text": prompt
              }
            ]
          }
        ],
        text: {
          "format": {
            "type": "text"
          }
        },
        reasoning: {},
        tools: [
          {
            "type": "image_generation",
            "size": finalSize,
            "quality": finalQuality,
            "output_format": "jpeg",
            "background": "auto",
            "moderation": "low",
            "partial_images": 0
          }
        ],
        temperature: 1,
        max_output_tokens: 2048,
        top_p: 1,
        store: true
      });      // Handle the response - cast to any to access the data structure
      const responseData = response as any;

      // Extract image generation data from response based on the actual OpenAI Responses API format
      // The image is in the output array with type="image_generation_call" and status="completed"
      let imageData = null;
      let revisedPrompt = null;

      if (responseData.output && Array.isArray(responseData.output)) {
        // Find the image generation call in the output array
        const imageGenerationCall = responseData.output.find((item: any) => 
          item.type === 'image_generation_call' && item.status === 'completed'
        );

        if (imageGenerationCall) {
          imageData = imageGenerationCall.result;
          revisedPrompt = imageGenerationCall.revised_prompt;
          
          logger.info('OpenAI: Found image generation call', {
            id: imageGenerationCall.id,
            size: imageGenerationCall.size,
            quality: imageGenerationCall.quality,
            outputFormat: imageGenerationCall.output_format,
            background: imageGenerationCall.background,
            revisedPrompt: revisedPrompt?.substring(0, 100) + '...'
          });
        }
      }

      if (!imageData) {
        // Log the full response structure for debugging
        console.error('OpenAI Responses API - No image data found. Full response structure:', JSON.stringify(responseData, null, 2));
        
        // Also log just the output array for easier debugging
        if (responseData.output) {
          console.error('Output array contents:', responseData.output.map((item: any) => ({
            type: item.type,
            status: item.status,
            id: item.id
          })));
        }
        
        throw new Error('No image generation call found in response');
      }

      const buffer = Buffer.from(imageData, 'base64');

      logger.info('OpenAI: Image generated successfully with Responses API', {
        model: this.model,
        promptLength: prompt.length,
        imageSize: buffer.length,
        dimensions: finalSize,
        quality: finalQuality,
        revisedPrompt: revisedPrompt?.substring(0, 100) + '...'
      });

      return buffer;
    } catch (error) {
      // If it's an OpenAI API error, log the response body
      if (error instanceof Error && 'response' in error) {
        const apiError = error as any;
        if (apiError.response) {
          console.error('OpenAI API Error Response Body:', JSON.stringify(apiError.response.data || apiError.response, null, 2));
          logger.error('OpenAI API Error Response', {
            status: apiError.response.status,
            statusText: apiError.response.statusText,
            data: apiError.response.data
          });
        }
      }

      // Also log the full error for debugging
      console.error('OpenAI Image Generation Error:', error);

      logger.error('OpenAI: Image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        promptLength: prompt.length,
        service: 'story-generation-workflow'
      });
      throw error;
    }
  }  private getSizeString(width?: number, height?: number): string {
    if (!width && !height) {
      return '1024x1024';
    }
    
    // Valid sizes for OpenAI Responses API
    const validSizes = ['1024x1024', '1024x1536', '1536x1024'];
    
    if (width && height) {
      const requestedSize = `${width}x${height}`;
      if (validSizes.includes(requestedSize)) {
        return requestedSize;
      }
      
      // Find the closest valid size based on aspect ratio
      const aspectRatio = width / height;
      if (aspectRatio > 1.3) {
        return '1536x1024'; // Landscape
      } else if (aspectRatio < 0.77) {
        return '1024x1536'; // Portrait
      } else {
        return '1024x1024'; // Square
      }
    }
    
    return '1024x1024';
  }
}
