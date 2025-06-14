/**
 * AI Gateway Interfaces
 * Provider-agnostic interfaces for text and image generation services
 */

export interface ITextGenerationService {
  /**
   * Complete a text generation request
   * @param prompt The input prompt
   * @param options Additional generation options
   */
  complete(prompt: string, options?: TextGenerationOptions): Promise<string>;
}

export interface IImageGenerationService {
  /**
   * Generate an image from a text prompt
   * @param prompt The image description prompt
   * @param options Additional generation options
   */
  generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer>;
}

export interface TextGenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  model?: string;
}

export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  model?: string;
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  steps?: number;
}

export interface AIProviderConfig {
  textProvider: string;
  imageProvider: string;
  credentials: {
    openaiApiKey?: string;
    vertexProjectId?: string;
    vertexLocation?: string;
    azureEndpoint?: string;
    azureApiKey?: string;
  };
}

export type TextProvider = 'vertex' | 'openai' | 'azure-openai';
export type ImageProvider = 'vertex' | 'stability' | 'openai' | 'dall-e';
