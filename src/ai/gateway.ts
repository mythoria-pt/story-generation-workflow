/**
 * AI Gateway Factory
 * Creates appropriate AI service instances based on environment configuration
 */

import { ITextGenerationService, IImageGenerationService, AIProviderConfig } from './interfaces.js';
import { OpenAITextService } from './providers/openai/text.js';
import { OpenAIImageService } from './providers/openai/image.js';
import { GoogleGenAITextService } from './providers/google-genai/text.js';
import { GoogleGenAIImageService } from './providers/google-genai/image.js';
import { logger } from '@/config/logger.js';

export class AIGateway {
  private textService: ITextGenerationService;
  private imageService: IImageGenerationService;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.textService = this.createTextService();
    this.imageService = this.createImageService();

    logger.info('AI Gateway initialized', {
      textProvider: config.textProvider,
      imageProvider: config.imageProvider,
    });
  }

  private createTextService(): ITextGenerationService {
    switch (this.config.textProvider.toLowerCase()) {
      case 'openai':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('OpenAI API Key is required for OpenAI text service');
        }
        return new OpenAITextService({
          apiKey: this.config.credentials.openaiApiKey,
        });

      case 'google-genai':
        if (!this.config.credentials.googleGenAIApiKey) {
          throw new Error('Google GenAI API Key is required for Google GenAI text service');
        }
        return new GoogleGenAITextService({
          apiKey: this.config.credentials.googleGenAIApiKey,
          model: this.config.credentials.googleGenAIModel || 'gemini-2.5-flash',
        });

      default:
        throw new Error(`Unsupported text provider: ${this.config.textProvider}`);
    }
  }

  private createImageService(): IImageGenerationService {
    switch (this.config.imageProvider.toLowerCase()) {
      case 'openai':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('OpenAI API Key is required for OpenAI image service');
        }
        return new OpenAIImageService({
          apiKey: this.config.credentials.openaiApiKey,
          model: this.config.credentials.openaiImageModel || 'gpt-5',
        });

      case 'google-genai': {
        if (!this.config.credentials.googleGenAIApiKey) {
          throw new Error('Google GenAI API Key is required for Google Imagen service');
        }
        const legacyEnvModel = process.env.IMAGE_GENERATION_MODEL;
        let selectedModel =
          legacyEnvModel ||
          this.config.credentials.googleGenAIImageModel ||
          'gemini-2.5-flash-image-preview'; // default to current Gemini image generation model
        if (selectedModel.startsWith('imagen-')) {
          logger.warn(
            'AI Gateway - legacy imagen-* model configured; remapping to gemini-2.5-flash-image-preview',
            { selectedModel },
          );
          selectedModel = 'gemini-2.5-flash-image-preview';
        }
        const service = new GoogleGenAIImageService({
          apiKey: this.config.credentials.googleGenAIApiKey,
          model: selectedModel,
        });
        logger.debug('AI Gateway - Google Imagen model resolved', {
          selectedModel,
          legacyEnvModel: !!legacyEnvModel,
          configuredModel: this.config.credentials.googleGenAIImageModel,
        });
        return service;
      }

      default:
        throw new Error(`Unsupported image provider: ${this.config.imageProvider}`);
    }
  }

  /**
   * Get the text generation service
   */
  public getTextService(): ITextGenerationService {
    return this.textService;
  }

  /**
   * Get the image generation service
   */
  public getImageService(): IImageGenerationService {
    return this.imageService;
  }

  /**
   * Create AI Gateway from environment variables
   */
  public static fromEnvironment(): AIGateway {
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
    const imageProvider = process.env.IMAGE_PROVIDER || 'google-genai';
    const config: AIProviderConfig = {
      textProvider,
      imageProvider,
      credentials: {
        ...(process.env.OPENAI_API_KEY && {
          openaiApiKey: process.env.OPENAI_API_KEY,
        }),
        // Always enable OpenAI Responses API (env flag removed)
        openaiUseResponsesAPI: true,
        ...(process.env.OPENAI_IMAGE_MODEL && {
          openaiImageModel: process.env.OPENAI_IMAGE_MODEL,
        }),
        ...(process.env.GOOGLE_GENAI_API_KEY && {
          googleGenAIApiKey: process.env.GOOGLE_GENAI_API_KEY,
        }),
        ...(process.env.GOOGLE_GENAI_MODEL && {
          googleGenAIModel: process.env.GOOGLE_GENAI_MODEL,
        }),
        ...(process.env.GOOGLE_GENAI_IMAGE_MODEL && {
          googleGenAIImageModel: process.env.GOOGLE_GENAI_IMAGE_MODEL,
        }),
      },
    };

    return new AIGateway(config);
  }
}
