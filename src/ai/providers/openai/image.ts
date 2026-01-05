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
  imageModel?: string;
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
  private imageModel: string;
  // private maxRetries: number; // Will be used in future retry logic
  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model =
      config.model ||
      process.env.OPENAI_BASE_MODEL ||
      process.env.OPENAI_TEXT_MODEL ||
      'gpt-5.2';
    this.imageModel =
      config.imageModel ||
      process.env.OPENAI_IMAGE_TOOL_MODEL ||
      'gpt-image-1.5';
    // maxRetries will be used in future retry logic
    // this.maxRetries = config.maxRetries || 3;
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const env = getEnvironment();
      const quality = env.OPENAI_IMAGE_QUALITY || 'low';

      logger.info('OpenAI: Generating image with Responses API', {
        model: this.model,
        imageToolModel: this.imageModel,
        promptLength: prompt.length,
        dimensions: this.getSizeString(options?.width, options?.height),
        quality,
      });

      // Ensure size is valid for the API
      const size = this.getSizeString(options?.width, options?.height);
      const validSizes = ['1024x1024', '1024x1536', '1536x1024'];
      const finalSize = validSizes.includes(size)
        ? (size as '1024x1024' | '1024x1536' | '1536x1024')
        : '1024x1536';

      // Ensure quality is valid for the API
      const validQualities = ['low', 'high', 'medium', 'auto'];
      const finalQuality = validQualities.includes(quality)
        ? (quality as 'low' | 'high' | 'medium' | 'auto')
        : 'low';

      // Prepare system message with book title and appropriate context based on image type
      const bookTitle = options?.bookTitle || 'Untitled Story';
      let systemMessage: string;

      try {
        // Dynamically import the PromptService to avoid circular dependencies
        const { PromptService } = await import('../../../services/prompt.js');

        if (options?.systemPrompt) {
          systemMessage = options.systemPrompt;
        } else {
          // Determine which prompt template to load based on image type
          const imageType = options?.imageType || 'chapter';

          try {
            // Load the appropriate prompt template
            const promptTemplate = await PromptService.loadImagePrompt(imageType);

            // Process the template variables
            const variables = {
              bookTitle,
              promptText: prompt,
              customInstructions: (options?.customInstructions ?? '').trim(),
            };

            // Use the prompt template for system message
            systemMessage = PromptService.processPrompt(
              promptTemplate.systemPrompt || '',
              variables,
            );
          } catch (promptError) {
            logger.warn('Failed to load image prompt template, using default', {
              error: promptError instanceof Error ? promptError.message : String(promptError),
              imageType: options?.imageType,
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
              const styleConfig = await PromptService.getImageStylePrompt(
                options.graphicalStyle as string,
              );
              systemMessage += `\n${styleConfig.systemPrompt}`;
            } catch (styleError) {
              logger.warn('Failed to load style configuration for image generation', {
                error: styleError instanceof Error ? styleError.message : String(styleError),
                graphicalStyle: options.graphicalStyle,
              });
              // Fallback to a generic style instruction
              systemMessage +=
                '\nCreate a high-quality, detailed image with good composition and visual appeal.';
            }
          } else {
            // Default style instruction when no specific style is provided
            systemMessage +=
              '\nCreate a high-quality, detailed image with good composition and visual appeal.';
          }
        }
      } catch (error) {
        logger.error('Error preparing image generation prompt', {
          error: error instanceof Error ? error.message : String(error),
        });

        // Ultimate fallback
        systemMessage = `This image is for the book "${bookTitle}". ${prompt} Create a high-quality, detailed image with good composition and visual appeal.`;
      }

      // Debug: Log the complete request being sent to OpenAI
      console.log('=== FULL OPENAI REQUEST DEBUG ===');
      console.log('Model:', this.model);
      console.log('Image tool model:', this.imageModel);
      console.log('=== System Message ===');
      console.log('System message text:', systemMessage);
      console.log('=== User Prompt ===');
      console.log('User prompt text:', prompt);
      console.log('User prompt length:', prompt.length);
      console.log('=== Tool Configuration ===');
      const toolConfig = {
        type: 'image_generation' as const,
        model: this.imageModel,
        size: finalSize,
        quality: finalQuality,
        output_format: 'jpeg' as const,
        background: 'opaque' as const,
        moderation: 'low' as const,
        partial_images: 0,
      };
      console.log('Image generation tool config:', JSON.stringify(toolConfig, null, 2));
      console.log('=== Request Structure ===');
      console.log('Model:', this.model);
      console.log('Temperature:', 1);
      console.log('Max output tokens:', 8192);
      console.log('Top P:', 1);
      console.log('Store:', true);
      console.log('=== END OPENAI REQUEST DEBUG ===');

      // Debug: Log the request parameters being sent to OpenAI
      logger.info('OpenAI: Request parameters for image generation', {
        model: this.model,
        imageToolModel: this.imageModel,
        promptLength: prompt.length,
        size: finalSize,
        quality: finalQuality,
        bookTitle: bookTitle,
        userPrompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
        systemPrompt: systemMessage,
        toolConfig: toolConfig,
      });

      const buildRequestBody = () => ({
        model: this.model,
        input: (() => {
          const input: any[] = [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text:
                    systemMessage +
                    '\nAlways produce the image output by invoking the image_generation tool. Do not return only text reasoning.',
                },
              ],
            },
          ];
          const userContent: any[] = [];
          const refImages = options?.referenceImages || [];
          if (refImages.length) {
            for (const ref of refImages) {
              try {
                const dataUrl = `data:${ref.mimeType || 'image/jpeg'};base64,${ref.buffer.toString('base64')}`;
                userContent.push({
                  type: 'input_image',
                  image_url: dataUrl,
                  detail: 'high',
                });
              } catch (e) {
                logger.warn('OpenAI: failed to encode reference image', {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
            userContent.push({
              type: 'input_text',
              text: 'The images above are authoritative references for visual style and recurring characters. Maintain consistency (faces, palette, clothing) unless explicitly instructed otherwise. Now generate a new image for the described scene.',
            });
          }
          userContent.push({ type: 'input_text', text: prompt });
          input.push({ role: 'user', content: userContent });
          return input;
        })(),
        // text format omitted to satisfy SDK typings when not explicitly requesting json
        tools: [toolConfig],
        temperature: 1,
        max_output_tokens: 8192,
        top_p: 1,
        store: true,
      });

      const response = await this.client.responses.create(buildRequestBody() as any);

      // Handle the response - use proper typing
      const responseData = response as unknown as OpenAIResponseData;

      // Debug: Log the complete response structure (limited)
      logger.info('OpenAI: Complete response received', {
        responseKeys: Object.keys(responseData),
        responseType: typeof responseData,
        hasOutput: !!responseData.output,
        outputLength: responseData.output ? responseData.output.length : 0,
      });

      const { imageData, revisedPrompt } = this.extractImageData(responseData, 'generate');
      if (!imageData) {
        throw new Error('No image generation payload located in response');
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
          if (sortedKeys.every((key) => /^\d+$/.test(key))) {
            base64Data = sortedKeys.map((key) => String(imageDataRecord[key])).join('');
          }
        }
      }

      if (!base64Data) {
        logger.error('OpenAI: No base64 image data found in response', {
          imageDataType: typeof imageData,
          imageDataExists: !!imageData,
          imageDataProperties: imageData ? Object.keys(imageData).length : 0,
        });
        throw new Error('No base64 image data found in response');
      }

      const buffer = Buffer.from(base64Data, 'base64');

      logger.info('OpenAI: Image generated successfully with Responses API', {
        model: this.model,
        imageToolModel: this.imageModel,
        promptLength: prompt.length,
        imageSize: buffer.length,
        dimensions: finalSize,
        quality: finalQuality,
        revisedPrompt: revisedPrompt?.substring(0, 100) + '...',
        referenceImageCount: options?.referenceImages?.length || 0,
        referenceImageSources: options?.referenceImages?.map((r) => r.source) || [],
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
          };
        };
        if (apiError.response) {
          console.error(
            'OpenAI API Error Response Body:',
            JSON.stringify(apiError.response.data || apiError.response, null, 2),
          );
          logger.error('OpenAI API Error Response', {
            status: apiError.response.status,
            statusText: apiError.response.statusText,
            data: apiError.response.data,
          });
        }
      }

      // Also log the full error for debugging
      console.error('OpenAI Image Generation Error:', error);

      logger.error('OpenAI: Image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        model: this.model,
        promptLength: prompt.length,
        service: 'story-generation-workflow',
      });
      throw error;
    }
  }

  /**
   * Edit an existing image based on a text prompt using OpenAI Responses API
   */ async edit(
    prompt: string,
    originalImage: Buffer,
    options?: ImageGenerationOptions,
  ): Promise<Buffer> {
    try {
      const env = getEnvironment();
      const quality = env.OPENAI_IMAGE_QUALITY || 'high';

      logger.info('OpenAI: EDIT METHOD CALLED - Editing image with Responses API', {
        model: this.model,
        imageToolModel: this.imageModel,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        dimensions: this.getSizeString(options?.width, options?.height),
        quality,
      });

      // Convert image buffer to base64 data URL format
      const base64Image = originalImage.toString('base64');
      const imageDataUrl = `data:image/png;base64,${base64Image}`;

      // Log the exact prompt being sent
      logger.info('OpenAI: Image edit prompt and data', {
        prompt: prompt,
        imageDataSize: base64Image.length,
        imageFormat: 'data URL',
      });

      // Ensure size is valid for the API
      const size = this.getSizeString(options?.width, options?.height);
      const validSizes = ['1024x1024', '1024x1536', '1536x1024'];
      const finalSize = validSizes.includes(size)
        ? (size as '1024x1024' | '1024x1536' | '1536x1024')
        : '1024x1536';

      // Ensure quality is valid for the API
      const validQualities = ['low', 'high', 'medium', 'auto'];
      const finalQuality = validQualities.includes(quality)
        ? (quality as 'low' | 'high' | 'medium' | 'auto')
        : 'high';

      const buildEditRequest = () => ({
        model: this.model,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: "You are an expert AI image editor and art director specializing in story illustrations. Your task is to take an existing story image and modify it according to the user's specific editing request while maintaining the artistic style, quality, and narrative coherence of the original image.\n\nYou MUST invoke the image_generation tool to produce an edited image. Do not respond with text only.",
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imageDataUrl, detail: 'high' },
            ],
          },
        ],
        tools: [
          {
            type: 'image_generation',
            model: this.imageModel,
            size: finalSize,
            quality: finalQuality,
            output_format: 'jpeg',
            background: 'opaque',
            moderation: 'auto',
            partial_images: 0,
          },
        ],
        temperature: 1,
        top_p: 1,
        max_output_tokens: 8192,
        store: true,
      });

      const response = await this.client.responses.create(buildEditRequest() as any);

      // Handle the response - use proper typing
      const responseData = response as unknown as OpenAIResponseData;

      const { imageData, revisedPrompt } = this.extractImageData(responseData, 'edit');
      if (!imageData) {
        throw new Error('No image generation payload located in edit response');
      }

      // Extract base64 data - handle both string and object cases
      let base64Data: string | null = null;
      if (typeof imageData === 'string') {
        base64Data = imageData;
      } else if (imageData && typeof imageData === 'object') {
        const imageDataObj = imageData as {
          b64_json?: string;
          url?: string;
          [key: string]: unknown;
        };
        base64Data = imageDataObj.b64_json || imageDataObj.url || null;

        // Handle array-like object case
        if (!base64Data && Object.keys(imageDataObj).length > 100) {
          const sortedKeys = Object.keys(imageDataObj).sort((a, b) => parseInt(a) - parseInt(b));
          if (sortedKeys.every((key) => /^\d+$/.test(key))) {
            base64Data = sortedKeys.map((key) => String(imageDataObj[key])).join('');
          }
        }
      }

      if (!base64Data) {
        throw new Error('No base64 image data found in edit response');
      }

      const buffer = Buffer.from(base64Data, 'base64');

      logger.info('OpenAI: Image edited successfully with Responses API', {
        model: this.model,
        imageToolModel: this.imageModel,
        promptLength: prompt.length,
        originalImageSize: originalImage.length,
        editedImageSize: buffer.length,
        dimensions: finalSize,
        quality: finalQuality,
        revisedPrompt: revisedPrompt?.substring(0, 100) + '...',
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
          };
        };
        if (apiError.response) {
          console.error(
            'OpenAI API Error Response Body (Image Edit):',
            JSON.stringify(apiError.response.data || apiError.response, null, 2),
          );
          logger.error('OpenAI API Error Response (Image Edit)', {
            status: apiError.response.status,
            statusText: apiError.response.statusText,
            data: apiError.response.data,
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
        service: 'story-generation-workflow',
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

  /**
   * Robust extraction of image data from a Responses API payload.
   * Supports multiple possible shapes while producing rich debug output on failure.
   */
  private extractImageData(
    responseData: OpenAIResponseData,
    phase: 'generate' | 'edit',
  ): { imageData: any; revisedPrompt: string | null } {
    let imageData: any = null;
    let revisedPrompt: string | null = null;

    const outputs: any[] = Array.isArray(responseData.output) ? responseData.output : [];

    // Pass 1: Original expected shape
    let call = outputs.find(
      (o) => o?.type === 'image_generation_call' && o?.status === 'completed',
    );
    if (call) {
      imageData = call.result;
      revisedPrompt = call.revised_prompt || null;
      logger.info(`OpenAI: Found image_generation_call (${phase})`, {
        phase,
        id: call.id,
        revisedPrompt: revisedPrompt?.substring(0, 100),
      });
      return { imageData, revisedPrompt };
    }

    // Pass 2: Look for direct image objects (e.g., type === 'image' or 'image_output')
    call = outputs.find(
      (o) => /image/i.test(o?.type || '') && (o?.b64_json || o?.result?.b64_json),
    );
    if (call) {
      imageData = call.b64_json ? call : call.result || call;
      revisedPrompt = call.revised_prompt || call.result?.revised_prompt || null;
      logger.info(`OpenAI: Found image payload by generic image type (${phase})`, {
        phase,
        type: call.type,
      });
      return { imageData, revisedPrompt };
    }

    // Pass 3: Tool call wrapper shapes
    call = outputs.find(
      (o) =>
        o?.type === 'tool_call' &&
        (o?.name === 'image_generation' || o?.tool_name === 'image_generation'),
    );
    if (call) {
      const candidate = call.output || call.result || call;
      if (candidate?.b64_json || candidate?.url) {
        imageData = candidate;
        revisedPrompt = candidate.revised_prompt || null;
        logger.info(`OpenAI: Found image payload within tool_call (${phase})`, { phase });
        return { imageData, revisedPrompt };
      }
    }

    // Pass 4: Deep scan for any object containing a plausible base64 field
    const b64Regex = /^[A-Za-z0-9+/=]{200,}$/; // length gate to reduce false positives
    for (const o of outputs) {
      if (!o || typeof o !== 'object') continue;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && b64Regex.test(v)) {
          imageData = v;
          logger.warn('OpenAI: Heuristic base64 extraction used', { phase, key: k });
          return { imageData, revisedPrompt };
        }
        if (
          v &&
          typeof v === 'object' &&
          (v as any).b64_json &&
          typeof (v as any).b64_json === 'string'
        ) {
          imageData = v;
          revisedPrompt = (v as any).revised_prompt || null;
          logger.warn('OpenAI: Heuristic object b64_json extraction used', { phase, key: k });
          return { imageData, revisedPrompt };
        }
      }
    }

    // Failure path: emit comprehensive debug
    try {
      console.error('=== OPENAI IMAGE EXTRACTION FAILURE DEBUG ===');
      console.error('Phase:', phase);
      console.error('Top-level keys:', Object.keys(responseData));
      console.error(
        'Output items summary:',
        outputs.map((o, i) => ({
          i,
          type: o?.type,
          keys: Object.keys(o || {}),
          hasResult: !!o?.result,
        })),
      );
      console.error('Full response JSON (truncated to 50k chars):');
      const serialized = JSON.stringify(responseData, null, 2);
      console.error(
        serialized.length > 50000 ? serialized.slice(0, 50000) + '\n...TRUNCATED...' : serialized,
      );
      console.error('=== END OPENAI IMAGE EXTRACTION FAILURE DEBUG ===');
    } catch {
      /* swallow logging errors */
    }

    logger.error('OpenAI: Unable to locate image data in response', {
      phase,
      outputLength: outputs.length,
    });
    return { imageData: null, revisedPrompt: null };
  }
}
