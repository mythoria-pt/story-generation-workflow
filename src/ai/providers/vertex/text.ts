/**
 * Vertex AI Text Generation Service
 */

import { VertexAI } from '@google-cloud/vertexai';
import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { logger } from '@/config/logger.js';

export interface VertexTextConfig {
  projectId: string;
  location: string;
  model?: string;
}

export class VertexTextService implements ITextGenerationService {
  private vertexAI: VertexAI;
  private model: string;

  constructor(config: VertexTextConfig) {
    this.vertexAI = new VertexAI({
      project: config.projectId,
      location: config.location
    });
    this.model = config.model || 'gemini-1.5-pro';
    
    logger.info('Vertex Text Service initialized', {
      projectId: config.projectId,
      location: config.location,
      model: this.model
    });
  }  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: options?.maxTokens || 4096,
        temperature: options?.temperature || 0.7,
        topP: options?.topP || 0.9,
        topK: options?.topK || 40
      };

      // Only add stopSequences if provided
      if (options?.stopSequences) {
        generationConfig.stopSequences = options.stopSequences;
      }

      const generativeModel = this.vertexAI.getGenerativeModel({
        model: options?.model || this.model,
        generationConfig
      });

      const response = await generativeModel.generateContent(prompt);
      const result = response.response.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!result) {
        throw new Error('No text generated from Vertex AI');
      }

      logger.debug('Vertex text generation completed', {
        promptLength: prompt.length,
        responseLength: result.length
      });

      return result;
    } catch (error) {
      logger.error('Vertex text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length
      });
      throw error;
    }
  }
}
