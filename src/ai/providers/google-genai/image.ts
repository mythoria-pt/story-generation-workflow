/**
 * Google Imagen Image Generation Service
 */

import {
  IImageGenerationService,
  ImageGenerationOptions,
} from "../../interfaces.js";
import { logger } from "@/config/logger.js";

export interface GoogleGenAIImageConfig {
  apiKey: string;
  model?: string;
}

interface ImagenGenerateResponse {
  generatedImages?: Array<{ image?: { imageBytes?: string } }>;
  [key: string]: unknown;
}

export class GoogleGenAIImageService implements IImageGenerationService {
  private apiKey: string;
  private model: string;

  constructor(config: GoogleGenAIImageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || "imagen-4.0-ultra-generate-001";

    logger.info("Google Imagen Service initialized", { model: this.model });
  }

  async generate(
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<Buffer> {
    try {
      const model = options?.model || this.model;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage?key=${this.apiKey}`;

      const body = {
        prompt,
        config: {
          numberOfImages: 1,
          sampleImageSize: "2K",
          aspectRatio: this.getAspectRatio(options?.width, options?.height),
          personGeneration: "allow_all",
        },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Google Imagen API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const data = (await response.json()) as ImagenGenerateResponse;
      const imageBytes = data.generatedImages?.[0]?.image?.imageBytes;
      if (!imageBytes) {
        throw new Error("No image returned from Google Imagen");
      }

      const buffer = Buffer.from(imageBytes, "base64");
      logger.info("Google Imagen: image generated", {
        model,
        promptLength: prompt.length,
        imageSize: buffer.length,
      });

      return buffer;
    } catch (error) {
      logger.error("Google Imagen image generation failed", {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
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
