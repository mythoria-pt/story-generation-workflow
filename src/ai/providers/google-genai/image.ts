/**
 * Google Imagen Image Generation Service
 */

import { IImageGenerationService, ImageGenerationOptions } from "../../interfaces.js";
import { logger } from "@/config/logger.js";
// Dynamic import to avoid Jest resolver issues unless Gemini models actually used
type GoogleGenAIType = any; // Minimal typing to avoid adding types

export interface GoogleGenAIImageConfig {
  apiKey: string;
  model?: string;
  projectId?: string; // for Vertex (Gemini image) models
  location?: string;  // e.g. 'us-central1' or 'global'
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

  constructor(config: GoogleGenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gemini-2.5-flash-image-preview";
  // Only enable vertex mode if explicitly requested; API key + projectId without proper auth can cause 404
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEX === 'true';
  this.projectId = useVertex ? (config.projectId || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined) : undefined;
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
        mappedModel: this.model
      });
    }

    // Gemini image preview / multimodal generation models start with 'gemini-' and require the @google/genai client
    // For Gemini image models we lazy-load the SDK in generate()

    logger.info("Google Imagen/Gemini Image Service initialized", {
      model: this.model,
      usingGeminiClient: !!this.genAIClient,
      projectId: this.projectId,
      location: this.location
    });
  }

  async generate(
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<Buffer> {
    try {
      const model = options?.model || this.model;

      // Gemini image (multimodal) path
  const forceRest = process.env.GOOGLE_GENAI_FORCE_REST === 'true';
      if (model.startsWith('gemini-') && !forceRest) {
        if (!this.genAIClient) {
          const { GoogleGenAI } = await import('@google/genai');
          // Only pass vertex options if projectId is defined (explicitly enabled)
            this.genAIClient = this.projectId ? new GoogleGenAI({
              apiKey: this.apiKey,
              vertexai: true,
              project: this.projectId,
              location: this.location
            } as any) : new GoogleGenAI({ apiKey: this.apiKey } as any);
        }
        logger.debug('Google Gemini Image Debug - using @google/genai client', {
          model,
          projectId: this.projectId,
          location: this.location,
          promptPreview: prompt.slice(0, 120)
        });

        // Non-streaming generate content per current docs for image generation
  const response = await (this.genAIClient as any).models.generateContent({
          model,
          contents: [ prompt ]
        });
  logger.debug('Google Gemini Image Debug - raw response keys', { model, hasCandidates: !!response?.candidates, keys: response ? Object.keys(response) : [] });
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
        if (!imagePartBase64) {
          logger.error('Google Gemini Image Debug - no inline image data in response', { model, candidateCount: candidates.length });
          throw new Error('No image data returned from Gemini image model');
        }
        const buffer = Buffer.from(imagePartBase64, 'base64');
        logger.info('Google Gemini Image: image generated', { model, size: buffer.length });
        return buffer;
      }

      // Legacy Imagen REST path (imagen-* models)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage?key=${this.apiKey}`;
      const body = {
        prompt: { text: prompt },
        imageGenerationConfig: {
          numberOfImages: 1,
          sampleImageSize: '2K',
          aspectRatio: this.getAspectRatio(options?.width, options?.height),
          personGeneration: 'allow_all'
        }
      };

      logger.debug('Google Imagen Debug - request prepared', {
        url,
        model,
        promptPreview: prompt.slice(0, 120),
        aspectRatio: body.imageGenerationConfig.aspectRatio,
        hasApiKey: !!this.apiKey
      });

      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        let errorText: string | undefined;
        try { errorText = await response.text(); } catch { /* ignore */ }
        logger.error('Google Imagen Debug - non 2xx response', {
          status: response.status,
          statusText: response.statusText,
          model,
          url,
          errorText: errorText?.slice(0, 500),
          headers: Object.fromEntries(response.headers.entries())
        });
        if (response.status === 404) {
          const hint = 'Model not found (404). Verify model name and API enablement. For Vertex-only model, supply project/location or switch to public imagen-* model.';
          throw new Error(`Google Imagen API error: ${response.status} ${response.statusText}${errorText ? ' - ' + errorText : ''}. Hint: ${hint}`);
        }
        throw new Error(`Google Imagen API error: ${response.status} ${response.statusText}${errorText ? ' - ' + errorText : ''}`);
      }
      const data = (await response.json()) as ImagenGenerateResponse;
      const imageBytes = data.generatedImages?.[0]?.image?.imageBytes;
      if (!imageBytes) {
        logger.error('Google Imagen Debug - no imageBytes in response', { keys: Object.keys(data || {}), model });
        throw new Error('No image returned from Google Imagen');
      }
      const buffer = Buffer.from(imageBytes, 'base64');
      logger.info('Google Imagen: image generated', { model, promptLength: prompt.length, imageSize: buffer.length });
      return buffer;
    } catch (error) {
      logger.error("Google Imagen image generation failed", {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        model: this.model
      });
      throw error;
    }
  }

  private getAspectRatio(
    width?: number,
    height?: number,
  ): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" {
    if (!width || !height) {
      return "3:4";
    }

    const ratio = width / height;
    if (ratio > 1.7) {
      return "16:9";
    }
    if (ratio > 1.3) {
      return "4:3";
    }
    if (ratio < 0.6) {
      return "9:16";
    }
    if (ratio < 0.8) {
      return "3:4";
    }
    return "1:1";
  }
}
