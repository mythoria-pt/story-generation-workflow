/**
 * Google Imagen Image Generation Service
 */

import { IImageGenerationService, ImageGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';
import { ImageGenerationBlockedError } from '@/ai/errors.js';
// Dynamic import to avoid Jest resolver issues unless Gemini models actually used
type GoogleGenAIType = any; // Minimal typing to avoid adding types

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
  private genAIClient?: GoogleGenAIType; // Only initialized for Gemini image models

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
    this.model = config.model || 'gemini-2.5-flash-image-preview';
    // Only enable vertex mode if explicitly requested; API key + projectId without proper auth can cause 404
    const useVertex = process.env.GOOGLE_GENAI_USE_VERTEX === 'true';
    this.projectId = useVertex
      ? config.projectId || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined
      : undefined;
    // Use dedicated GENAI region var; default to global
    this.location = config.location || process.env.GOOGLE_GENAI_CLOUD_REGION || 'global';

    // Map deprecated Imagen REST models (imagen-4.*-generate-001) to current Gemini image model.
    // Google has removed the legacy /models/imagen-*/:generateImage endpoint (404 as of Aug 2025).
    const disableMapping = process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING === 'true';
    if (this.model.startsWith('imagen-') && !disableMapping) {
      const legacy = this.model;
      this.model = 'gemini-2.5-flash-image-preview';
      logger.warn('Legacy Google Imagen model detected; mapping to Gemini image model', {
        legacyModel: legacy,
        mappedModel: this.model,
      });
    }

    // Gemini image preview / multimodal generation models start with 'gemini-' and require the @google/genai client
    // For Gemini image models we lazy-load the SDK in generate()

    logger.info('Google Imagen/Gemini Image Service initialized', {
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

      // Gemini image (multimodal) path
      const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';
      if (model.startsWith('gemini-') && !forceRest) {
        const client = await this.getGenAIClient();
        logger.debug('Google Gemini Image Debug - using @google/genai client', {
          model,
          projectId: this.projectId,
          location: this.location,
          promptPreview: prompt.slice(0, 120),
        });

        // Build multimodal parts: optional reference images first, then instruction, then prompt text
        const parts: any[] = [];
        const referenceImages = options?.referenceImages ?? [];
        const refCount = referenceImages.length;
        if (refCount) {
          for (const ref of referenceImages) {
            try {
              parts.push({
                inlineData: {
                  data: ref.buffer.toString('base64'),
                  mimeType: ref.mimeType || 'image/jpeg',
                },
              });
            } catch (e) {
              logger.warn('Failed to encode reference image for Gemini', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          // Only add the hardcoded reference instruction if no system prompt is provided,
          // or if we want to ensure it's always there.
          // With Gemini 3, we can rely on the system prompt for this if passed.
          // For now, we keep it but make it less "authoritative" if system prompt exists?
          // Actually, the plan said "improve reference image logic".
          // Let's keep it simple: if systemPrompt is passed, we assume it handles style instructions.
          // But reference images still need context.
          parts.push({
            text: 'The preceding images are reference material. Use them to maintain consistency in characters and style.',
          });
        }
        parts.push({ text: prompt });

        const generateRequest: any = {
          model,
          contents: [{ role: 'user', parts }],
          config: {
            generationConfig: {
              aspectRatio,
            },
          },
        };

        // Add system instruction if provided
        if (options?.systemPrompt) {
          // In @google/genai SDK, systemInstruction is often part of the config
          generateRequest.config.systemInstruction = {
            parts: [{ text: options.systemPrompt }],
          };
        }

        // Non-streaming generate content per current docs for image generation
        const response = await (client as any).models.generateContent(generateRequest);
        logger.debug('Google Gemini Image Debug - raw response keys', {
          model,
          hasCandidates: !!response?.candidates,
          keys: response ? Object.keys(response) : [],
        });
        const imagePartBase64 = this.extractInlineImageBase64(response, model);
        const buffer = Buffer.from(imagePartBase64, 'base64');
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

  async edit(prompt: string, originalImage: Buffer, options?: ImageGenerationOptions): Promise<Buffer> {
    const model = options?.model || this.model;
    const aspectRatio = this.resolveAspectRatio(options);
    const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';

    try {
      // Prefer true edit via Gemini image models; otherwise fall back to reference-guided generate.
      if (model.startsWith('gemini-') && !forceRest) {
        const client = await this.getGenAIClient();
        const primaryMime =
          options?.referenceImages?.[0]?.mimeType ||
          (options?.imageType === 'front_cover' || options?.imageType === 'back_cover'
            ? 'image/jpeg'
            : 'image/png');

        const parts: any[] = [
          {
            inlineData: {
              data: originalImage.toString('base64'),
              mimeType: primaryMime,
            },
          },
        ];

        for (const ref of options?.referenceImages || []) {
          try {
            parts.push({
              inlineData: {
                data: ref.buffer.toString('base64'),
                mimeType: ref.mimeType || 'image/jpeg',
              },
            });
          } catch (e) {
            logger.warn('Failed to encode supplemental reference image for Gemini edit', {
              error: e instanceof Error ? e.message : String(e),
              source: ref.source,
            });
          }
        }

        parts.push({ text: prompt });

        const generateRequest: any = {
          model,
          contents: [{ role: 'user', parts }],
          config: {
            generationConfig: {
              aspectRatio,
            },
            responseModalities: ['IMAGE'],
          },
        };

        if (options?.systemPrompt) {
          generateRequest.config.systemInstruction = {
            parts: [{ text: options.systemPrompt }],
          };
        }

        const response = await (client as any).models.generateContent(generateRequest);
        const imagePartBase64 = this.extractInlineImageBase64(response, model);
        const buffer = Buffer.from(imagePartBase64, 'base64');
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

  private resolveAspectRatio(
    options?: ImageGenerationOptions,
  ): '1:1' | '2:3' | '3:4' | '4:3' | '9:16' | '16:9' {
    const allowed: Record<string, boolean> = {
      '1:1': true,
      '2:3': true,
      '3:4': true,
      '4:3': true,
      '9:16': true,
      '16:9': true,
    };

    if (options?.aspectRatio && allowed[options.aspectRatio]) {
      return options.aspectRatio as '1:1' | '2:3' | '3:4' | '4:3' | '9:16' | '16:9';
    }

    return this.getAspectRatio(options?.width, options?.height);
  }

  private getAspectRatio(
    width?: number,
    height?: number,
  ): '1:1' | '2:3' | '3:4' | '4:3' | '9:16' | '16:9' {
    if (!width || !height) {
      return '2:3';
    }

    const ratio = width / height;
    if (ratio >= 1.7) {
      return '16:9';
    }
    if (ratio >= 1.3) {
      return '4:3';
    }
    if (ratio <= 0.6) {
      return '9:16';
    }
    if (ratio <= 0.72) {
      return '2:3';
    }
    if (ratio <= 0.9) {
      return '3:4';
    }
    return '1:1';
  }

  private async getGenAIClient(): Promise<GoogleGenAIType> {
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
    return this.genAIClient as GoogleGenAIType;
  }

  private extractInlineImageBase64(response: any, model: string): string {
    const candidates = response?.candidates || [];
    let imagePartBase64: string | undefined;
    for (const c of candidates) {
      const parts = c?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          imagePartBase64 = p.inlineData.data;
          break;
        }
      }
      if (imagePartBase64) break;
    }
    if (imagePartBase64) {
      return imagePartBase64;
    }

    const candidateDiagnostics = candidates.map((c: any, idx: number) => ({
      idx,
      finishReason: c.finishReason,
      hasContent: !!c.content,
      partCount: c.content?.parts?.length || 0,
      partSummaries: (c.content?.parts || []).map((p: any) => ({
        keys: Object.keys(p),
        hasInline: !!p.inlineData,
        hasText: !!p.text,
      })),
    }));
    const finishReasons = Array.from(
      new Set(candidateDiagnostics.map((d: any) => d.finishReason).filter(Boolean)),
    ) as string[];
    logger.error('Google Gemini Image Debug - no inline image data in response', {
      model,
      candidateCount: candidates.length,
      candidateDiagnostics,
      finishReasons,
    });
    if (finishReasons.length && finishReasons.every((r) => r === 'PROHIBITED_CONTENT')) {
      throw new ImageGenerationBlockedError({
        provider: 'google-genai',
        finishReasons,
        diagnostics: candidateDiagnostics,
        message:
          'Image generation blocked by Google safety filters (reason: PROHIBITED_CONTENT). Adjust prompt to comply with content policies.',
      });
    }

    throw new Error(
      'No image data returned from Gemini image model' +
        (finishReasons.length ? ` (finishReasons=${finishReasons.join(',')})` : ''),
    );
  }
}
