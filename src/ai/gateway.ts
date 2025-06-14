/**
 * AI Gateway Factory
 * Creates appropriate AI service instances based on environment configuration
 */

import { ITextGenerationService, IImageGenerationService, AIProviderConfig } from './interfaces.js';
import { VertexTextService } from './providers/vertex/text.js';
import { VertexImageService } from './providers/vertex/image.js';
import { OpenAITextService } from './providers/openai/text.js';
import { OpenAIImageService } from './providers/openai/image.js';
import { StabilityImageService } from './providers/stability/image.js';
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
      imageProvider: config.imageProvider
    });
  }  private createTextService(): ITextGenerationService {
    switch (this.config.textProvider.toLowerCase()) {
      case 'vertex':
        if (!this.config.credentials.vertexProjectId) {
          throw new Error('Vertex Project ID is required for Vertex AI text service');
        }
        return new VertexTextService({
          projectId: this.config.credentials.vertexProjectId,
          location: this.config.credentials.vertexLocation || 'us-central1',
          model: this.config.credentials.vertexModel || 'gemini-2.0-flash'
        });      case 'openai':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('OpenAI API Key is required for OpenAI text service');
        }
        return new OpenAITextService({
          apiKey: this.config.credentials.openaiApiKey,
          useResponsesAPI: this.config.credentials.openaiUseResponsesAPI ?? true // Default to new Responses API
        });
      
      default:
        throw new Error(`Unsupported text provider: ${this.config.textProvider}`);
    }
  }
  private createImageService(): IImageGenerationService {
    switch (this.config.imageProvider.toLowerCase()) {
      case 'vertex':
        if (!this.config.credentials.vertexProjectId) {
          throw new Error('Vertex Project ID is required for Vertex AI image service');
        }
        return new VertexImageService({
          projectId: this.config.credentials.vertexProjectId,
          location: this.config.credentials.vertexLocation || 'us-central1'
        });
      
      case 'openai':
      case 'dall-e':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('OpenAI API Key is required for OpenAI image service');
        }
        return new OpenAIImageService({
          apiKey: this.config.credentials.openaiApiKey
        });
      
      case 'stability':
        if (!this.config.credentials.openaiApiKey) {
          throw new Error('API Key is required for Stability AI service');
        }
        return new StabilityImageService({
          apiKey: this.config.credentials.openaiApiKey // Reusing for now, should be separate
        });
      
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
    const textProvider = process.env.TEXT_PROVIDER || 'vertex';
    const imageProvider = process.env.IMAGE_PROVIDER || 'vertex';    const config: AIProviderConfig = {
      textProvider,
      imageProvider,      credentials: {
        ...(process.env.OPENAI_API_KEY && { openaiApiKey: process.env.OPENAI_API_KEY }),
        ...(process.env.OPENAI_USE_RESPONSES_API !== undefined && { 
          openaiUseResponsesAPI: process.env.OPENAI_USE_RESPONSES_API === 'true' 
        }),
        ...(process.env.GOOGLE_CLOUD_PROJECT_ID && { vertexProjectId: process.env.GOOGLE_CLOUD_PROJECT_ID }),
        ...(process.env.VERTEX_AI_LOCATION && { vertexLocation: process.env.VERTEX_AI_LOCATION }),
        ...(process.env.GOOGLE_CLOUD_REGION && !process.env.VERTEX_AI_LOCATION && { vertexLocation: process.env.GOOGLE_CLOUD_REGION }),
        ...(process.env.VERTEX_AI_MODEL_ID && { vertexModel: process.env.VERTEX_AI_MODEL_ID }),
        ...(process.env.VERTEX_AI_OUTLINE_MODEL && { vertexOutlineModel: process.env.VERTEX_AI_OUTLINE_MODEL })
      }
    };

    return new AIGateway(config);
  }
}
