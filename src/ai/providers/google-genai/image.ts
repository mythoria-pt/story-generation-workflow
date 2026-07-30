/**
 * Google Gemini Image Generation Service
 */

import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import {
  ImageGenerationBlockedError,
  ImageOtherError,
  type ProviderDiagnostic,
} from '@/ai/errors.js';
import type { GoogleGenAI } from '@google/genai';

export interface GoogleGenAIImageConfig {
  apiKey: string;
  model?: string;
  projectId?: string; // for Vertex (Gemini image) models
  location?: string; // e.g. 'us-central1' or 'global'
}

interface ImagenGenerateResponse {
  generatedImages?: Array<{ image?: { imageBytes?: string } }>;
  [key: string]: unknown;
}

export class GoogleGenAIImageService implements IImageGenerationService {
  private apiKey: string;
  private model: string;
  private projectId: string | undefined;
  private location: string | undefined;
  private genAIClient?: GoogleGenAI; // Lazily initialized for Gemini image models

  /**
   * Normalise Gemini / Google API error surfaces for better logging.
   */
  private static extractGoogleError(err: unknown) {
    const out: Record<string, unknown> = {};
    const anyErr: any = err;
    const source = anyErr?.cause?.error || anyErr?.response?.error || anyErr?.error || anyErr;
    if (source) {
      if (source.code) out.code = source.code;
      if (source.status) out.status = source.status;
      if (source.message) out.apiMessage = source.message;
      if (Array.isArray(source.details) && source.details.length) {
        out.details = source.details.slice(0, 2);
      }
    }
    if (!out.status && typeof anyErr?.message === 'string') {
      const token = anyErr.message.split(/[ :]/)[0];
      if (token && token === token.toUpperCase() && token.length < 40) {
        out.statusGuess = token;
      }
    }
    return out;
  }

  constructor(config: GoogleGenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-3.1-flash-image';
    // Only enable vertex mode if explicitly requested; API key + projectId without proper auth can cause 404
    const useVertex = process.env.GOOGLE_GENAI_USE_VERTEX === 'true';
    this.projectId = useVertex
      ? config.projectId || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined
      : undefined;
    // Use dedicated GENAI region var; default to global
    this.location = config.location || process.env.GOOGLE_GENAI_CLOUD_REGION || 'global';

    // Map deprecated Imagen REST models to the current stable Gemini image model.
    // The REST branch remains only as an explicit compatibility fallback for legacy configurations.
    const disableMapping = process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING === 'true';
    if (this.model.startsWith('imagen-') && !disableMapping) {
      const legacy = this.model;
      this.model = 'gemini-3.1-flash-image';
      logger.warn('Legacy Google Imagen model detected; mapping to Gemini image model', {
        legacyModel: legacy,
        mappedModel: this.model,
      });
    }

    // Gemini image models use the current @google/genai Interactions API.

    logger.info('Google Gemini Image Service initialized', {
      model: this.model,
      usingGeminiClient: !!this.genAIClient,
      projectId: this.projectId,
      location: this.location,
    });
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      const model = options?.model || this.model;
      const aspectRatio = this.resolveAspectRatio(options);

      // Current Gemini image path through the Interactions API.
      const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';
      if (model.startsWith('gemini-') && !forceRest) {
        const client = await this.getGenAIClient();
        logger.debug('Google Gemini Image Debug - using Interactions API', {
          model,
          projectId: this.projectId,
          location: this.location,
          promptPreview: prompt.slice(0, 120),
        });

        const input: Array<
          { type: 'image'; data: string; mime_type: string } | { type: 'text'; text: string }
        > = [];
        const referenceImages = options?.referenceImages ?? [];
        const refCount = referenceImages.length;
        for (const ref of referenceImages) {
          try {
            input.push({
              type: 'image',
              data: ref.buffer.toString('base64'),
              mime_type: ref.mimeType || 'image/jpeg',
            });
          } catch (error) {
            logger.warn('Failed to encode reference image for Gemini', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (refCount) {
          input.push({
            type: 'text',
            text: 'The preceding images are reference material. Use them to maintain consistency in characters and style.',
          });
        }
        input.push({ type: 'text', text: prompt });

        const response = await client.interactions.create({
          model,
          input,
          ...(options?.systemPrompt && { system_instruction: options.systemPrompt }),
          response_format: {
            type: 'image',
            mime_type: 'image/png',
            aspect_ratio: aspectRatio,
            ...(this.supportsImageSize(model) && { image_size: '2K' }),
          },
        });

        logger.debug('Google Gemini Image Debug - interaction completed', {
          model,
          status: response.status,
          hasOutputImage: !!response.output_image?.data,
          stepCount: response.steps.length,
        });
        const imageBase64 = this.extractInteractionImageBase64(response, model);
        const buffer = Buffer.from(imageBase64, 'base64');
        logger.info('Google Gemini Image: image generated', {
          model,
          size: buffer.length,
          referenceImageCount: refCount,
        });
        return buffer;
      }
      // Legacy Imagen REST path (imagen-* models)
      if (options?.referenceImages?.length) {
        logger.warn('Reference images provided but ignored for legacy Imagen REST model', {
          model,
          referenceImageCount: options.referenceImages.length,
        });
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage?key=${this.apiKey}`;
      const body = {
        prompt: { text: prompt },
        imageGenerationConfig: {
          numberOfImages: 1,
          sampleImageSize: '2K',
          aspectRatio,
          personGeneration: 'allow_all',
        },
      };

      logger.debug('Google Imagen Debug - request prepared', {
        url,
        model,
        promptPreview: prompt.slice(0, 120),
        aspectRatio: body.imageGenerationConfig.aspectRatio,
        hasApiKey: !!this.apiKey,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let errorText: string | undefined;
        try {
          errorText = await response.text();
        } catch {
          /* ignore */
        }
        logger.error('Google Imagen Debug - non 2xx response', {
          status: response.status,
          statusText: response.statusText,
          model,
          url,
          errorText: errorText?.slice(0, 500),
          headers: Object.fromEntries(response.headers.entries()),
        });
        if (response.status === 404) {
          const hint =
            'Model not found (404). Verify model name and API enablement. For Vertex-only model, supply project/location or switch to public imagen-* model.';
          throw new Error(
            `Google Imagen API error: ${response.status} ${response.statusText}${errorText ? ' - ' + errorText : ''}. Hint: ${hint}`,
          );
        }
        throw new Error(
          `Google Imagen API error: ${response.status} ${response.statusText}${errorText ? ' - ' + errorText : ''}`,
        );
      }
      const data = (await response.json()) as ImagenGenerateResponse;
      const imageBytes = data.generatedImages?.[0]?.image?.imageBytes;
      if (!imageBytes) {
        logger.error('Google Imagen Debug - no imageBytes in response', {
          keys: Object.keys(data || {}),
          model,
        });
        throw new Error('No image returned from Google Imagen');
      }
      const buffer = Buffer.from(imageBytes, 'base64');
      logger.info('Google Imagen: image generated', {
        model,
        promptLength: prompt.length,
        imageSize: buffer.length,
      });
      return buffer;
    } catch (error) {
      const structured = GoogleGenAIImageService.extractGoogleError(error);
      logger.error('Google Imagen image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        ...structured,
        promptLength: prompt.length,
        model: this.model,
        promptPreview: prompt.slice(0, 160),
      });
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(String(error));
      }
    }
  }

  async edit(
    prompt: string,
    originalImage: Buffer,
    options?: ImageGenerationOptions,
  ): Promise<Buffer> {
    const model = options?.model || this.model;
    const aspectRatio = this.resolveAspectRatio(options);
    const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';

    try {
      // Prefer native multimodal editing through the current Interactions API.
      if (model.startsWith('gemini-') && !forceRest) {
        const client = await this.getGenAIClient();
        const primaryMime =
          options?.referenceImages?.[0]?.mimeType ||
          (options?.imageType === 'front_cover' || options?.imageType === 'back_cover'
            ? 'image/jpeg'
            : 'image/png');
        const input: Array<
          { type: 'image'; data: string; mime_type: string } | { type: 'text'; text: string }
        > = [
          {
            type: 'image',
            data: originalImage.toString('base64'),
            mime_type: primaryMime,
          },
        ];

        for (const ref of options?.referenceImages || []) {
          try {
            input.push({
              type: 'image',
              data: ref.buffer.toString('base64'),
              mime_type: ref.mimeType || 'image/jpeg',
            });
          } catch (error) {
            logger.warn('Failed to encode supplemental reference image for Gemini edit', {
              error: error instanceof Error ? error.message : String(error),
              source: ref.source,
            });
          }
        }
        input.push({ type: 'text', text: prompt });

        const response = await client.interactions.create({
          model,
          input,
          ...(options?.systemPrompt && { system_instruction: options.systemPrompt }),
          response_format: {
            type: 'image',
            mime_type: 'image/png',
            aspect_ratio: aspectRatio,
            ...(this.supportsImageSize(model) && { image_size: '2K' }),
          },
        });
        const imageBase64 = this.extractInteractionImageBase64(response, model);
        const buffer = Buffer.from(imageBase64, 'base64');
        logger.info('Google Gemini Image: edit completed', {
          model,
          size: buffer.length,
          referenceImageCount: options?.referenceImages?.length || 0,
          imageType: options?.imageType,
        });
        return buffer;
      }
      logger.info('Gemini edit path unavailable; using generate() with reference image', {
        model,
        useRestFallback: forceRest,
        imageType: options?.imageType,
      });

      return this.generate(prompt, {
        ...options,
        referenceImages: [
          {
            buffer: originalImage,
            mimeType: options?.referenceImages?.[0]?.mimeType || 'image/jpeg',
            source: 'edit-original',
          },
          ...(options?.referenceImages || []),
        ],
      });
    } catch (error) {
      const structured = GoogleGenAIImageService.extractGoogleError(error);
      logger.error('Google Imagen image edit failed', {
        error: error instanceof Error ? error.message : String(error),
        ...structured,
        promptLength: prompt.length,
        model: this.model,
      });
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    }
  }

  /**
   * Supported aspect ratios for Gemini image models.
   * Gemini 3.1 Flash adds: 1:4, 4:1, 1:8, 8:1, 4:5, 5:4
   */
  private static readonly ALLOWED_ASPECT_RATIOS = new Set([
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
    '1:4',
    '4:1',
    '1:8',
    '8:1',
  ]);

  private resolveAspectRatio(options?: ImageGenerationOptions): string {
    if (
      options?.aspectRatio &&
      GoogleGenAIImageService.ALLOWED_ASPECT_RATIOS.has(options.aspectRatio)
    ) {
      return options.aspectRatio;
    }

    return this.getAspectRatio(options?.width, options?.height);
  }

  private getAspectRatio(width?: number, height?: number): string {
    if (!width || !height) {
      return '2:3';
    }

    const ratio = width / height;
    if (ratio >= 2.0) return '21:9';
    if (ratio >= 1.7) return '16:9';
    if (ratio >= 1.3) return '4:3';
    if (ratio >= 1.1) return '5:4';
    if (ratio <= 0.6) return '9:16';
    if (ratio <= 0.72) return '2:3';
    if (ratio <= 0.8) return '3:4';
    if (ratio <= 0.9) return '4:5';
    return '1:1';
  }

  /**
   * Returns true for Gemini 3+ image models that support the imageSize parameter.
   * Gemini 2.5 has fixed resolutions per aspect ratio; Gemini 3 supports 1K/2K/4K (3.1 also 512px).
   */
  private supportsImageSize(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('gemini-3');
  }

  private async getGenAIClient(): Promise<GoogleGenAI> {
    if (!this.genAIClient) {
      const { GoogleGenAI } = await import('@google/genai');
      this.genAIClient = this.projectId
        ? new GoogleGenAI({
            apiKey: this.apiKey,
            vertexai: true,
            project: this.projectId,
            location: this.location,
          } as any)
        : new GoogleGenAI({ apiKey: this.apiKey } as any);
    }
    return this.genAIClient;
  }

  private extractInteractionImageBase64(
    response: {
      output_image?: { data?: string | undefined } | undefined;
      steps?:
        | Array<{
            type?: string | undefined;
            content?: Array<{ type?: string | undefined; data?: string | undefined }> | undefined;
            error?:
              | {
                  code?: number | undefined;
                  message?: string | undefined;
                  status?: string | undefined;
                  details?: unknown[] | undefined;
                }
              | undefined;
          }>
        | undefined;
      status?: string | undefined;
      usage?: unknown | undefined;
    },
    model: string,
  ): string {
    if (response.output_image?.data) {
      return response.output_image.data;
    }

    const steps = response.steps ?? [];
    for (const step of steps) {
      if (step.type !== 'model_output') continue;
      for (const content of step.content ?? []) {
        if (content.type === 'image' && content.data) {
          return content.data;
        }
      }
    }

    const modelErrors: ProviderDiagnostic[] = steps.flatMap((step, idx) =>
      step.type === 'model_output' && step.error ? [{ idx, ...step.error }] : [],
    );
    const diagnosticText = JSON.stringify({ status: response.status, modelErrors }).toUpperCase();
    const safetyReasons = ['PROHIBITED_CONTENT', 'SAFETY', 'BLOCKLIST'].filter((reason) =>
      diagnosticText.includes(reason),
    );

    logger.error('Google Gemini Image Debug - no image content in interaction response', {
      model,
      status: response.status,
      stepCount: steps.length,
      modelErrors,
      usage: response.usage ?? null,
    });

    if (safetyReasons.length > 0) {
      throw new ImageGenerationBlockedError({
        provider: 'google-genai',
        finishReasons: safetyReasons,
        diagnostics: modelErrors,
        message: `Image generation blocked by Google safety filters (reason: ${safetyReasons.join(',')}). Adjust prompt to comply with content policies.`,
      });
    }

    if (diagnosticText.includes('IMAGE_OTHER')) {
      throw new ImageOtherError({
        provider: 'google-genai',
        finishReasons: ['IMAGE_OTHER'],
        diagnostics: modelErrors,
        message:
          'Image generation returned IMAGE_OTHER from Gemini (may be transient or a soft safety block).',
      });
    }

    throw new Error(
      `No image data returned from Gemini image interaction (status=${response.status || 'unknown'}).`,
    );
  }
}
