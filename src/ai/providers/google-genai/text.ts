/**
 * Google GenAI Text Generation Service
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export interface GoogleGenAITextConfig {
  apiKey: string;
  model?: string;
}

export class GoogleGenAITextService implements ITextGenerationService {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: GoogleGenAITextConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.model || 'gemini-2.5-flash';
    
    logger.info('Google GenAI Text Service initialized', {
      model: this.model
    });
  }

  /**
   * Convert JSON Schema to Google GenAI Schema format
   */
  private convertJsonSchemaToGenAISchema(jsonSchema: any): any {
    const convertType = (type: string) => {
      switch (type) {
        case 'string': return 'STRING';
        case 'integer': return 'INTEGER';
        case 'number': return 'NUMBER';
        case 'boolean': return 'BOOLEAN';
        case 'array': return 'ARRAY';
        case 'object': return 'OBJECT';
        default: return 'STRING';
      }
    };

    const convertSchema = (schema: any): any => {
      const result: any = {
        type: convertType(schema.type)
      };

      if (schema.description) {
        result.description = schema.description;
      }

      if (schema.type === 'object' && schema.properties) {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
          result.properties[key] = convertSchema(value);
        }
        
        if (schema.required && Array.isArray(schema.required)) {
          result.required = schema.required;
        }

        // Add property ordering if available or create a default one
        if (schema.required && Array.isArray(schema.required)) {
          result.propertyOrdering = schema.required.concat(
            Object.keys(schema.properties).filter(key => !schema.required.includes(key))
          );
        } else {
          result.propertyOrdering = Object.keys(schema.properties);
        }
      }

      if (schema.type === 'array' && schema.items) {
        result.items = convertSchema(schema.items);
        if (schema.maxItems) {
          result.maxItems = schema.maxItems;
        }
        if (schema.minItems) {
          result.minItems = schema.minItems;
        }
      }

      if (schema.enum && Array.isArray(schema.enum)) {
        result.enum = schema.enum;
      }

      if (schema.maxLength) {
        result.maxLength = schema.maxLength;
      }

      if (schema.minLength) {
        result.minLength = schema.minLength;
      }

      return result;
    };

    return convertSchema(jsonSchema);
  }
  /**
   * Initialize context for a story generation session
   * Creates a stateful chat instance using Google GenAI's ai.chats API
   */
  async initializeContext(
    contextId: string, 
    systemPrompt: string
  ): Promise<void> {
    try {
      // Create a chat instance for stateful conversations
      const generativeModel = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: systemPrompt
      });

      const chat = generativeModel.startChat({
        history: [], // Start with empty history, system prompt is handled by systemInstruction
      });

      // Store the chat instance in context manager
      const context = await contextManager.getContext(contextId);
      if (context) {
        await contextManager.updateProviderData(contextId, {
          googleGenAI: {
            chatInstance: chat
          }
        });
      }

      logger.info('Google GenAI chat context initialized', {
        contextId,
        model: this.model
      });
    } catch (error) {
      logger.error('Failed to initialize Google GenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId
      });
      throw error;
    }
  }

  /**
   * Clear context for a specific session
   */
  async clearContext(contextId: string): Promise<void> {
    try {
      const context = await contextManager.getContext(contextId);
      if (context?.providerSpecificData.googleGenAI?.chatInstance) {
        // Clear the chat instance reference
        await contextManager.updateProviderData(contextId, {
          googleGenAI: {
            chatInstance: undefined
          }
        });
        
        logger.info('Google GenAI context cleared', {
          contextId
        });
      }
    } catch (error) {
      logger.error('Failed to clear Google GenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId
      });
      throw error;
    }
  }
  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      let response;
        // Try to get existing chat instance for stateful conversation
      if (options?.contextId) {
        const context = await contextManager.getContext(options.contextId);
        const chat = context?.providerSpecificData.googleGenAI?.chatInstance;
        
        if (chat) {
          // For stateful conversation with JSON schema, we need to create a new model
          // since chat instances don't support changing responseSchema on the fly
          if (options?.jsonSchema) {
            const generationConfig: any = {
              maxOutputTokens: options?.maxTokens || 4096,
              temperature: options?.temperature || 0.7,
              topP: options?.topP || 0.9,
              topK: options?.topK || 40,
              ...(options?.stopSequences && { stopSequences: options.stopSequences }),
              responseMimeType: 'application/json',
              responseSchema: this.convertJsonSchemaToGenAISchema(options.jsonSchema)
            };

            const generativeModel = this.genAI.getGenerativeModel({
              model: options?.model || this.model,
              generationConfig
            });

            logger.info('Google GenAI Debug - Using structured output with context', {
              contextId: options.contextId,
              model: this.model,
              hasJsonSchema: true
            });

            response = await generativeModel.generateContent(prompt);
          } else {
            // Use existing chat instance for stateful conversation without JSON schema
            logger.info('Google GenAI Debug - Using stateful chat', {
              contextId: options.contextId,
              model: this.model
            });
            
            response = await chat.sendMessage(prompt);
          }
        }
      }
        // If no chat instance exists, create a new one for stateless generation
      if (!response) {
        const generationConfig: any = {
          maxOutputTokens: options?.maxTokens || 8192,
          temperature: options?.temperature || 0.7,
          topP: options?.topP || 0.9,
          topK: options?.topK || 40,
          ...(options?.stopSequences && { stopSequences: options.stopSequences }),
        };

        // Handle JSON schema for structured output
        if (options?.jsonSchema) {
          generationConfig.responseMimeType = 'application/json';
          generationConfig.responseSchema = this.convertJsonSchemaToGenAISchema(options.jsonSchema);
          
          logger.info('Google GenAI Debug - Using structured output', {
            schema: generationConfig.responseSchema,
            contextId: options?.contextId
          });
        }

        const generativeModel = this.genAI.getGenerativeModel({
          model: options?.model || this.model,
          generationConfig
        });

        logger.info('Google GenAI Debug - Using stateless generation', {
          model: options?.model || this.model,
          contextId: options?.contextId || 'none',
          hasJsonSchema: !!options?.jsonSchema
        });

        response = await generativeModel.generateContent(prompt);
      }
      
      // Extract the text response
      const candidate = response.response.candidates?.[0];
      if (!candidate) {
        throw new Error('No candidates returned from Google GenAI');
      }

      const textContent = candidate.content?.parts?.[0]?.text;
      if (!textContent) {
        throw new Error('No text content in Google GenAI response');
      }

      logger.info('Google GenAI Debug - Response received', {
        model: options?.model || this.model,
        responseLength: textContent.length,
        contextId: options?.contextId
      });

      return textContent;

    } catch (error) {
      logger.error('Google GenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        model: options?.model || this.model,
        contextId: options?.contextId
      });
      throw error;
    }
  }
}
