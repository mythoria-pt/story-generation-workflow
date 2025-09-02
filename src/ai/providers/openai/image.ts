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
}

interface OpenAIImageGenerationCall {
  type: string;
  status: string;
  id?: string;
  size?: string;
  quality?: string;
  output_format?: string;
  background?: string;
  revised_prompt?: string;
  result?: {
    url?: string;
    b64_json?: string;
  };
}

interface OpenAIResponseData {
  output?: OpenAIImageGenerationCall[];
  [key: string]: unknown;
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
    this.model = config.model || 'gpt-5';
    // maxRetries will be used in future retry logic
    // this.maxRetries = config.maxRetries || 3;
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
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
      const finalSize = validSizes.includes(size) ? size as '1024x1024' | '1024x1536' | '1536x1024' : '1024x1536';

      // Ensure quality is valid for the API
      const validQualities = ['low', 'high', 'medium', 'auto'];
      const finalQuality = validQualities.includes(quality) ? quality as 'low' | 'high' | 'medium' | 'auto' : 'low';

      // Prepare system message with book title and appropriate context based on image type
      const bookTitle = options?.bookTitle || 'Untitled Story';
      let systemMessage: string;
      
      try {
        // Dynamically import the PromptService to avoid circular dependencies
        const { PromptService } = await import('../../../services/prompt.js');
        
        // Determine which prompt template to load based on image type
        const imageType = options?.imageType || 'chapter';
        
        try {
          // Load the appropriate prompt template
          const promptTemplate = await PromptService.loadImagePrompt(imageType);
          
          // Process the template variables
          const variables = {
            bookTitle,
            promptText: prompt
          };
          
          // Use the prompt template for system message
          systemMessage = PromptService.processPrompt(promptTemplate.systemPrompt || '', variables);
        } catch (promptError) {
          logger.warn('Failed to load image prompt template, using default', {
            error: promptError instanceof Error ? promptError.message : String(promptError),
            imageType: options?.imageType
          });
          
          // Fallback to hardcoded system message
          switch (options?.imageType) {
            case 'front_cover':
              systemMessage = `This image is the front cover of a book, title "${bookTitle}".`;
              break;
            case 'back_cover':
              systemMessage = `This image is the back cover of a book, title "${bookTitle}".`;
              break;
            case 'chapter':
              systemMessage = `This image is an illustration for a chapter in the book "${bookTitle}". Create a scene that captures the essence of the chapter content.`;
              break;
            default:
              systemMessage = `This image is an illustration for the book "${bookTitle}".`;
              break;
          }
        }
        
        // If graphicalStyle is provided, append style guidelines
        if (options && 'graphicalStyle' in options && options.graphicalStyle) {
          try {
            const styleConfig = await PromptService.getImageStylePrompt(options.graphicalStyle as string);
            systemMessage += `\n${styleConfig.systemPrompt}`;
          } catch (styleError) {
            logger.warn('Failed to load style configuration for image generation', {
              error: styleError instanceof Error ? styleError.message : String(styleError),
              graphicalStyle: options.graphicalStyle
            });
            // Fallback to a generic style instruction
            systemMessage += '\nCreate a high-quality, detailed image with good composition and visual appeal.';
          }
        } else {
          // Default style instruction when no specific style is provided
          systemMessage += '\nCreate a high-quality, detailed image with good composition and visual appeal.';
        }
      } catch (error) {
        logger.error('Error preparing image generation prompt', {
          error: error instanceof Error ? error.message : String(error)
        });
        
        // Ultimate fallback
        systemMessage = `This image is for the book "${bookTitle}". ${prompt} Create a high-quality, detailed image with good composition and visual appeal.`;
      }

      // Debug: Log the complete request being sent to OpenAI
      console.log('=== FULL OPENAI REQUEST DEBUG ===');
      console.log('Model:', this.model);
      console.log('=== System Message ===');
      console.log('System message text:', systemMessage);
      console.log('=== User Prompt ===');
      console.log('User prompt text:', prompt);
      console.log('User prompt length:', prompt.length);
      console.log('=== Tool Configuration ===');
      const toolConfig = {
        "type": "image_generation" as const,
        "size": finalSize,
        "quality": finalQuality,
        "output_format": "jpeg" as const,
        "background": "opaque" as const,
        "moderation": "low" as const,
        "partial_images": 0
      };
      console.log('Image generation tool config:', JSON.stringify(toolConfig, null, 2));
      console.log('=== Request Structure ===');
      console.log('Model:', this.model);
      console.log('Temperature:', 1);
      console.log('Max output tokens:', 2048);
      console.log('Top P:', 1);
      console.log('Store:', true);
      console.log('=== END OPENAI REQUEST DEBUG ===');

      // Debug: Log the request parameters being sent to OpenAI
      logger.info('OpenAI: Request parameters for image generation', {
        model: this.model,
        promptLength: prompt.length,
        size: finalSize,
        quality: finalQuality,
        bookTitle: bookTitle,
        userPrompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
        systemPrompt: systemMessage,
        toolConfig: toolConfig
      });

      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            "role": "system",
            "content": [
              {
                "type": "input_text",
                "text": systemMessage
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
        tools: [toolConfig],
        temperature: 1,
        max_output_tokens: 2048,
        top_p: 1,
        store: true
      });
      
      // Handle the response - use proper typing
      const responseData = response as unknown as OpenAIResponseData;

      // Debug: Log the complete response structure (limited)
      logger.info('OpenAI: Complete response received', {
        responseKeys: Object.keys(responseData),
        responseType: typeof responseData,
        hasOutput: !!responseData.output,
        outputLength: responseData.output ? responseData.output.length : 0
      });

      // Extract image generation data from response based on the actual OpenAI Responses API format
      // The image is in the output array with type="image_generation_call" and status="completed"
      let imageData = null;
      let revisedPrompt = null;

      if (responseData.output && Array.isArray(responseData.output)) {
        // Find the image generation call in the output array
        const imageGenerationCall = responseData.output.find((item: OpenAIImageGenerationCall) => 
          item.type === 'image_generation_call' && item.status === 'completed'
        );

        if (imageGenerationCall) {
          imageData = imageGenerationCall.result;
          revisedPrompt = imageGenerationCall.revised_prompt;
          
          // Debug: Log detailed information about the found image generation call
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
        console.error('=== NO IMAGE DATA FOUND DEBUG ===');
        console.error('OpenAI Responses API - No image data found. Full response structure:', JSON.stringify(responseData, null, 2));
        
        // Also log just the output array for easier debugging
        if (responseData.output) {
          console.error('Output array length:', responseData.output.length);
          console.error('Output array contents:', responseData.output.map((item: OpenAIImageGenerationCall) => ({
            type: item.type,
            status: item.status,
            id: item.id,
            hasResult: !!item.result,
            resultKeys: item.result ? Object.keys(item.result) : 'no result'
          })));
          
          // Log each output item in detail
          responseData.output.forEach((item: OpenAIImageGenerationCall, index: number) => {
            console.error(`Output item ${index}:`, JSON.stringify(item, null, 2));
          });
        } else {
          console.error('No output array found in response');
        }
        console.error('=== END NO IMAGE DATA DEBUG ===');
        
        throw new Error('No image generation call found in response');
      }

      // Extract base64 image data efficiently
      let base64Data = null;
      
      // Check if imageData is directly a string (base64 data)
      if (typeof imageData === 'string') {
        base64Data = imageData;
      } else if (imageData && typeof imageData === 'object') {
        // Check for base64 data in object properties
        base64Data = imageData.b64_json || imageData.url;
        
        // If still not found, check if it's an array-like object containing the base64 string
        if (!base64Data && Object.keys(imageData).length > 100) {
          // It might be an array-like object where the base64 string is spread across indices
          const imageDataRecord = imageData as Record<string, unknown>;
          const sortedKeys = Object.keys(imageDataRecord).sort((a, b) => parseInt(a) - parseInt(b));
          if (sortedKeys.every(key => /^\d+$/.test(key))) {
            base64Data = sortedKeys.map(key => String(imageDataRecord[key])).join('');
          }
        }
      }
      
      if (!base64Data) {
        logger.error('OpenAI: No base64 image data found in response', {
          imageDataType: typeof imageData,
          imageDataExists: !!imageData,
          imageDataProperties: imageData ? Object.keys(imageData).length : 0
        });
        throw new Error('No base64 image data found in response');
      }

      const buffer = Buffer.from(base64Data, 'base64');

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
        const apiError = error as Error & { 
          response?: { 
            status?: number; 
            statusText?: string; 
            data?: unknown; 
          } 
        };
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
  }

  /**
   * Edit an existing image based on a text prompt using OpenAI Responses API
   */  async edit(prompt: string, originalImage: Buffer, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const env = getEnvironment();
      const quality = env.OPENAI_IMAGE_QUALITY || 'high';
      
      logger.info('OpenAI: EDIT METHOD CALLED - Editing image with Responses API', {
        model: this.model,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        dimensions: this.getSizeString(options?.width, options?.height),
        quality
      });

      // Convert image buffer to base64 data URL format
      const base64Image = originalImage.toString('base64');
      const imageDataUrl = `data:image/png;base64,${base64Image}`;
      
      // Log the exact prompt being sent
      logger.info('OpenAI: Image edit prompt and data', {
        prompt: prompt,
        imageDataSize: base64Image.length,
        imageFormat: 'data URL'
      });

      // Ensure size is valid for the API
      const size = this.getSizeString(options?.width, options?.height);
      const validSizes = ['1024x1024', '1024x1536', '1536x1024'];
      const finalSize = validSizes.includes(size) ? size as '1024x1024' | '1024x1536' | '1536x1024' : '1024x1536';

      // Ensure quality is valid for the API
      const validQualities = ['low', 'high', 'medium', 'auto'];
      const finalQuality = validQualities.includes(quality) ? quality as 'low' | 'high' | 'medium' | 'auto' : 'high';

      const response = await this.client.responses.create({
        model: this.model,
        input: [
          {
            "role": "system",
            "content": [
              {
                "type": "input_text",
                "text": "You are an expert AI image editor and art director specializing in story illustrations. Your task is to take an existing story image and modify it according to the user's specific editing request while maintaining the artistic style, quality, and narrative coherence of the original image.\n\n## Key Guidelines:\n\n### Style Preservation\n- Maintain the original artistic style, color palette, and visual aesthetic\n- Preserve the overall composition and lighting mood unless specifically requested to change\n- Keep consistent character appearance and environmental details from the original\n\n### Quality Standards\n- Generate high-quality, detailed images suitable for story illustration\n- Ensure all elements are well-rendered and professionally composed\n- Maintain clarity and visual appeal appropriate for the story's target audience\n\n### Narrative Coherence\n- Ensure the edited image still fits within the story context\n- Preserve story-relevant details and elements unless modification is specifically requested\n- Keep character consistency and environmental continuity\n\n### User Request Processing\n- Carefully analyze the user's editing request to understand exactly what needs to be changed\n- Make only the requested modifications while preserving everything else\n- If the request is ambiguous, make reasonable interpretations that enhance the story illustration\n\n### Technical Considerations\n- Generate images that are suitable for digital story presentation\n- Ensure proper resolution and aspect ratio for story illustration use\n- Maintain professional illustration quality standards\n\n## Image Editing Process:\n1. Analyze the original image to understand its style, composition, and story context\n2. Process the user's specific editing request\n3. Generate a modified version that incorporates the requested changes while preserving the original's strengths\n4. Ensure the final result maintains narrative coherence and artistic quality\n\nYour goal is to create an improved version of the story image that fulfills the user's editing vision while maintaining the professional quality and story relevance of the original illustration."
              }
            ]
          },
          {
            "role": "user",
            "content": [
              {
                "type": "input_text",
                "text": prompt
              },              {
                "type": "input_image",
                "image_url": imageDataUrl,
                "detail": "high"
              }
            ]
          }
        ],
        tools: [
          {
            "type": "image_generation",
            "size": finalSize,
            "quality": finalQuality,
            "output_format": "jpeg",
            "background": "opaque",
            "moderation": "auto",
            "partial_images": 0
          }
        ],
        text: {
          "format": {
            "type": "text"
          }
        },
        temperature: 1,
        top_p: 1,
        reasoning: {},
        stream: false,
        max_output_tokens: 2048,
        store: true
      });
      
      // Handle the response - use proper typing
      const responseData = response as unknown as OpenAIResponseData;

      // Extract image generation data from response
      let imageData = null;
      let revisedPrompt = null;

      if (responseData.output && Array.isArray(responseData.output)) {
        // Find the image generation call in the output array
        const imageGenerationCall = responseData.output.find((item: OpenAIImageGenerationCall) => 
          item.type === 'image_generation_call' && item.status === 'completed'
        );

        if (imageGenerationCall) {
          imageData = imageGenerationCall.result;
          revisedPrompt = imageGenerationCall.revised_prompt;
          
          logger.info('OpenAI: Found image generation call for editing', {
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
        console.error('OpenAI Responses API - No image data found in edit response. Full response structure:', JSON.stringify(responseData, null, 2));
        
        // Also log just the output array for easier debugging
        if (responseData.output) {
          console.error('Output array contents:', responseData.output.map((item: OpenAIImageGenerationCall) => ({
            type: item.type,
            status: item.status,
            id: item.id
          })));
        }
        
        throw new Error('No image generation call found in edit response');
      }

      // Extract base64 data - handle both string and object cases
      let base64Data: string | null = null;
      if (typeof imageData === 'string') {
        base64Data = imageData;
      } else if (imageData && typeof imageData === 'object') {
        const imageDataObj = imageData as { b64_json?: string; url?: string; [key: string]: unknown };
        base64Data = imageDataObj.b64_json || imageDataObj.url || null;
        
        // Handle array-like object case
        if (!base64Data && Object.keys(imageDataObj).length > 100) {
          const sortedKeys = Object.keys(imageDataObj).sort((a, b) => parseInt(a) - parseInt(b));
          if (sortedKeys.every(key => /^\d+$/.test(key))) {
            base64Data = sortedKeys.map(key => String(imageDataObj[key])).join('');
          }
        }
      }

      if (!base64Data) {
        throw new Error('No base64 image data found in edit response');
      }

      const buffer = Buffer.from(base64Data, 'base64');

      logger.info('OpenAI: Image edited successfully with Responses API', {
        model: this.model,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        editedImageSize: buffer.length,
        dimensions: finalSize,
        quality: finalQuality,
        revisedPrompt: revisedPrompt?.substring(0, 100) + '...'
      });

      return buffer;
    } catch (error) {
      // If it's an OpenAI API error, log the response body
      if (error instanceof Error && 'response' in error) {
        const apiError = error as Error & { 
          response?: { 
            status?: number; 
            statusText?: string; 
            data?: unknown; 
          } 
        };
        if (apiError.response) {
          console.error('OpenAI API Error Response Body (Image Edit):', JSON.stringify(apiError.response.data || apiError.response, null, 2));
          logger.error('OpenAI API Error Response (Image Edit)', {
            status: apiError.response.status,
            statusText: apiError.response.statusText,
            data: apiError.response.data
          });
        }
      }

      // Also log the full error for debugging
      console.error('OpenAI Image Editing Error:', error);

      logger.error('OpenAI: Image editing failed', {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        service: 'story-generation-workflow'
      });
      throw error;
    }
  }

  private getSizeString(width?: number, height?: number): string {
    if (!width && !height) {
      const env = getEnvironment();
      return `${env.IMAGE_DEFAULT_WIDTH}x${env.IMAGE_DEFAULT_HEIGHT}`; // Use environment configuration
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
    
    const env = getEnvironment();
    return `${env.IMAGE_DEFAULT_WIDTH}x${env.IMAGE_DEFAULT_HEIGHT}`; // Use environment configuration
  }
}
