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
  
  /**
   * Initialize or update context for a story generation session
   * @param contextId Unique identifier for the context session
   * @param systemPrompt The system prompt that defines the story context
   * @param previousContent Previous conversation content to maintain context
   */
  initializeContext?(contextId: string, systemPrompt: string, previousContent?: string[]): Promise<void>;
  
  /**
   * Clear context for a specific session
   * @param contextId Unique identifier for the context session
   */
  clearContext?(contextId: string): Promise<void>;
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
  contextId?: string; // For context preservation across requests
  jsonSchema?: object; // JSON schema for structured output
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
  imageProvider: string;  credentials: {
    openaiApiKey?: string;
    openaiUseResponsesAPI?: boolean;
    openaiImageModel?: string;
    googleGenAIApiKey?: string;
    googleGenAIModel?: string;
  };
}

export type TextProvider = 'openai' | 'google-genai';
export type ImageProvider = 'openai';
