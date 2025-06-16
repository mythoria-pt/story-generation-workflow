/**
 * Vertex AI Text Generation Service
 */

import { VertexAI } from '@google-cloud/vertexai';
import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { contextManager } from '../../context-manager.js';
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
    this.model = config.model || 'gemini-2.0-flash';
    
    logger.info('Vertex Text Service initialized', {
      projectId: config.projectId,
      location: config.location,
      model: this.model
    });
  }

  /**
   * Initialize context for a story generation session
   */
  async initializeContext(
    contextId: string, 
    systemPrompt: string, 
    previousContent?: string[]
  ): Promise<void> {
    try {
      // For Google Vertex AI, we can use cachedContent for efficient context management
      // Create a cached content entry with the system prompt and previous content
      const content = [systemPrompt, ...(previousContent || [])].join('\n\n');
      
      // In a real implementation, you would create a cached content using the Vertex AI API
      // For now, we'll store it in our context manager
      const context = await contextManager.getContext(contextId);
      if (context) {
        await contextManager.updateProviderData(contextId, {
          vertex: {
            cachedContentId: contextId, // Using contextId as cached content ID for simplicity
            cachedContentName: `story-context-${contextId}`
          }
        });
      }
      
      logger.info('Vertex context initialized', {
        contextId,
        contentLength: content.length
      });
    } catch (error) {
      logger.error('Failed to initialize Vertex context', {
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
      if (context?.providerSpecificData.vertex?.cachedContentName) {
        // In a real implementation, you would delete the cached content from Vertex AI
        // For now, we'll just clear it from our context manager
        logger.info('Vertex context cleared', {
          contextId,
          cachedContentName: context.providerSpecificData.vertex.cachedContentName
        });
      }
    } catch (error) {
      logger.error('Failed to clear Vertex context', {
        error: error instanceof Error ? error.message : String(error),
        contextId
      });
      throw error;
    }
  }  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: options?.maxTokens || 4096,
        temperature: options?.temperature || 0.7,
        topP: options?.topP || 0.9,
        topK: options?.topK || 40
      };      // Only add stopSequences if provided
      if (options?.stopSequences) {
        generationConfig.stopSequences = options.stopSequences;
      }

      let finalPrompt = prompt;
      let contextHistory: string[] = [];

      // If contextId is provided, incorporate conversation history
      if (options?.contextId) {
        const context = await contextManager.getContext(options.contextId);
        if (context) {
          // Build conversation history from context
          contextHistory = context.conversationHistory
            .filter(entry => entry.role !== 'system') // System prompt is already included
            .map(entry => `${entry.role}: ${entry.content}`)
            .slice(-10); // Keep last 10 entries to avoid token limit issues

          // Add user prompt to context history
          await contextManager.addConversationEntry(
            options.contextId,
            'user',
            prompt,
            options.contextId // Use contextId as step identifier
          );
        }
      }      // Combine context history with current prompt
      if (contextHistory.length > 0) {
        finalPrompt = `${contextHistory.join('\n\n')}\n\nuser: ${prompt}`;
      }

      // Configure JSON schema if provided
      if (options?.jsonSchema) {
        // For Vertex AI, we'll add instructions to the prompt for JSON output
        if (!finalPrompt.includes('JSON')) {
          finalPrompt += '\n\nIMPORTANT: Respond with valid JSON only, following the provided schema structure.';
        }
      }
      const generativeModel = this.vertexAI.getGenerativeModel({
        model: options?.model || this.model,
        generationConfig,
        ...(options?.jsonSchema && {
          responseFormat: {
            type: 'json_object'
          }
        })
      });

      // DEBUG: Log the exact request being sent to Vertex AI
      logger.info('Vertex AI Debug - Request Details', {
        model: options?.model || this.model,
        generationConfig,
        promptLength: finalPrompt.length,
        promptPreview: finalPrompt.substring(0, 300) + '...',
        hasJsonSchema: !!options?.jsonSchema,
        contextId: options?.contextId,
        contextHistoryLength: contextHistory.length
      });

      // For full debugging, log the complete prompt
      if (process.env.DEBUG_AI_FULL_PROMPTS === 'true') {
        logger.debug('Vertex AI Debug - Full Request', {
          model: options?.model || this.model,
          generationConfig,
          fullPrompt: finalPrompt,
          jsonSchema: options?.jsonSchema,
          contextHistory
        });
      }

      const response = await generativeModel.generateContent(finalPrompt);
      
      // DEBUG: Log the raw response from Vertex AI
      logger.info('Vertex AI Debug - Response Details', {
        model: options?.model || this.model,
        responseStructure: {
          hasCandidates: !!response.response.candidates,
          candidatesCount: response.response.candidates?.length || 0,
          hasContent: !!response.response.candidates?.[0]?.content,
          hasText: !!response.response.candidates?.[0]?.content?.parts?.[0]?.text
        },
        finishReason: response.response.candidates?.[0]?.finishReason,
        contextId: options?.contextId
      });

      // For full debugging, log the complete response
      if (process.env.DEBUG_AI_FULL_RESPONSES === 'true') {
        logger.debug('Vertex AI Debug - Full Response', {
          fullResponse: response.response,
          candidates: response.response.candidates
        });
      }

      const result = response.response.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!result) {
        logger.error('Vertex AI Debug - No text in response', {
          response: response.response,
          candidates: response.response.candidates,
          model: options?.model || this.model
        });
        throw new Error('No text generated from Vertex AI');
      }

      // DEBUG: Log the extracted result
      logger.info('Vertex AI Debug - Extracted Result', {
        resultLength: result.length,
        resultPreview: result.substring(0, 300) + '...',
        startsWithBackticks: result.startsWith('```'),
        containsJsonMarkers: result.includes('```json') || result.includes('```'),
        firstChar: result.charAt(0),
        lastChar: result.charAt(result.length - 1),
        contextId: options?.contextId
      });

      // Add assistant response to context history
      if (options?.contextId) {
        await contextManager.addConversationEntry(
          options.contextId,
          'assistant',
          result,
          options.contextId
        );
      }

      logger.debug('Vertex text generation completed', {
        promptLength: prompt.length,
        responseLength: result.length,
        contextId: options?.contextId,
        usedContext: contextHistory.length > 0
      });

      return result;
    } catch (error) {
      logger.error('Vertex text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        contextId: options?.contextId
      });
      throw error;
    }
  }
}
