/**
 * OpenAI Text Generation Service
 */

import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export interface OpenAITextConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  useResponsesAPI?: boolean; // Flag to enable new Responses API
}

interface OpenAIRequestBody {
  model: string;
  input: string;
  modalities: string[];
  instructions: string;
  temperature: number;
  max_output_tokens: number;
  response_format?: {
    type: string;
    json_schema: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
    };
  };
  previous_response_id?: string;
  stop?: string[];
  [key: string]: unknown; // Allow additional properties
}

interface OpenAIChatRequestBody {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  response_format?: {
    type: string;
    json_schema?: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
    };
  };
  [key: string]: unknown; // Allow additional properties
}

export class OpenAITextService implements ITextGenerationService {
  private apiKey: string;
  private model: string;
  private baseURL: string;
  private useResponsesAPI: boolean;

  constructor(config: OpenAITextConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4.1';
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
    this.useResponsesAPI = config.useResponsesAPI ?? true; // Default to new API
    
    logger.info('OpenAI Text Service initialized', {
      model: this.model,
      baseURL: this.baseURL,
      useResponsesAPI: this.useResponsesAPI
    });
  }  /**
   * Initialize context for a story generation session
   */
  async initializeContext(
    contextId: string, 
    systemPrompt: string, 
    previousContent?: string[]
  ): Promise<void> {
    try {
      if (this.useResponsesAPI) {
        // For Responses API, we can make an initial call to establish context
        // and get a response_id for future conversation continuity
        try {
          const response = await this.completeWithResponsesAPI(
            'Please acknowledge that you understand the context and are ready to help.',
            { contextId, maxTokens: 50 }
          );
          
          logger.debug('Initial context established with Responses API', {
            contextId,
            responseLength: response.length
          });
        } catch (error) {
          logger.warn('Failed to establish initial context with Responses API, will continue without pre-initialization', {
            contextId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        // Legacy chat completions approach
        const context = await contextManager.getContext(contextId);
        if (context) {
          await contextManager.updateProviderData(contextId, {
            openai: {
              conversationId: contextId
            }
          });
        }
      }
      
      logger.info('OpenAI context initialized', {
        contextId,
        systemPromptLength: systemPrompt.length,
        previousContentLength: previousContent?.length || 0,
        useResponsesAPI: this.useResponsesAPI
      });
    } catch (error) {
      logger.error('Failed to initialize OpenAI context', {
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
      // For OpenAI, we just need to clear the context from our manager
      // No special API calls needed
      logger.info('OpenAI context cleared', { contextId });
    } catch (error) {
      logger.error('Failed to clear OpenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId
      });
      throw error;
    }
  }
  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      if (this.useResponsesAPI) {
        return await this.completeWithResponsesAPI(prompt, options);
      } else {
        return await this.completeWithChatCompletions(prompt, options);
      }
    } catch (error) {
      logger.error('OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        contextId: options?.contextId,
        useResponsesAPI: this.useResponsesAPI
      });
      throw error;
    }
  }

  /**
   * Complete using the new Responses API
   */
  private async completeWithResponsesAPI(prompt: string, options?: TextGenerationOptions): Promise<string> {
    let input = prompt;
    let previousResponseId: string | undefined;

    // Build input with system context if contextId is provided
    if (options?.contextId) {
      const context = await contextManager.getContext(options.contextId);
      if (context) {
        // Combine system prompt with user input
        input = context.systemPrompt + '\n\nUser: ' + prompt;
        
        // Get previous response_id for conversation continuity
        previousResponseId = context.providerSpecificData.openai?.responseId;

        // Add current user prompt to context
        await contextManager.addConversationEntry(
          options.contextId,
          'user',
          prompt,
          options.contextId
        );
      }
    }    const requestBody: OpenAIRequestBody = {
      model: options?.model || this.model,
      input,
      modalities: ['text'],
      instructions: 'Please assist the user with their request.',
      temperature: options?.temperature || 0.7,
      max_output_tokens: options?.maxTokens || 4096
    };    // Configure JSON schema if provided
    if (options?.jsonSchema) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'story_outline',
          description: 'Story outline structure',
          schema: options.jsonSchema as Record<string, unknown>
        }
      };
    }

    // Add previous_response_id for conversation continuity
    if (previousResponseId) {
      requestBody.previous_response_id = previousResponseId;
    }// Add stop sequences if provided
    if (options?.stopSequences) {
      requestBody.stop = options.stopSequences;
    }

    // DEBUG: Log the exact request being sent to OpenAI Responses API
    logger.info('OpenAI Responses API Debug - Request Details', {
      model: requestBody.model,
      inputLength: requestBody.input.length,
      inputPreview: requestBody.input.substring(0, 300) + '...',
      temperature: requestBody.temperature,
      maxOutputTokens: requestBody.max_output_tokens,
      hasJsonSchema: !!requestBody.response_format,
      hasPreviousResponseId: !!requestBody.previous_response_id,
      contextId: options?.contextId
    });

    // For full debugging, log the complete request
    if (process.env.DEBUG_AI_FULL_PROMPTS === 'true') {
      logger.debug('OpenAI Responses API Debug - Full Request', {
        requestBody,
        contextId: options?.contextId
      });
    }

    const response = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error('OpenAI Responses API Debug - Request Failed', {
        status: response.status,
        statusText: response.statusText,
        errorData,
        requestPreview: JSON.stringify(requestBody).substring(0, 500),
        contextId: options?.contextId
      });
      throw new Error(`OpenAI Responses API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    
    // DEBUG: Log the raw response from OpenAI Responses API
    logger.info('OpenAI Responses API Debug - Response Details', {
      responseId: data.id,
      hasOutput: !!data.output,
      outputLength: data.output?.length || 0,
      outputTypes: data.output?.map((item: any) => item.type) || [],
      contextId: options?.contextId
    });

    // For full debugging, log the complete response
    if (process.env.DEBUG_AI_FULL_RESPONSES === 'true') {
      logger.debug('OpenAI Responses API Debug - Full Response', {
        fullResponse: data,
        contextId: options?.contextId
      });
    }
    
    // Extract text content from the new response format
    const outputMessage = data.output?.find((item: any) => item.type === 'message');
    const textContent = outputMessage?.content?.find((content: any) => content.type === 'output_text');
    const result = textContent?.text;

    if (!result) {
      logger.error('OpenAI Responses API Debug - No text in response', {
        data,
        outputMessage,
        textContent,
        contextId: options?.contextId
      });
      throw new Error('No text generated from OpenAI Responses API');
    }

    // DEBUG: Log the extracted result
    logger.info('OpenAI Responses API Debug - Extracted Result', {
      resultLength: result.length,
      resultPreview: result.substring(0, 300) + '...',
      startsWithBackticks: result.startsWith('```'),
      containsJsonMarkers: result.includes('```json') || result.includes('```'),
      firstChar: result.charAt(0),
      lastChar: result.charAt(result.length - 1),
      contextId: options?.contextId
    });

    // Store response_id for future context continuity
    if (options?.contextId && data.id) {
      const context = await contextManager.getContext(options.contextId);
      if (context) {
        await contextManager.updateProviderData(options.contextId, {
          openai: {
            responseId: data.id,
            conversationId: context.providerSpecificData.openai?.conversationId || options.contextId
          }
        });

        // Add assistant response to context
        await contextManager.addConversationEntry(
          options.contextId,
          'assistant',
          result,
          options.contextId
        );
      }
    }

    logger.debug('OpenAI Responses API text generation completed', {
      promptLength: prompt.length,
      responseLength: result.length,
      responseId: data.id,
      contextId: options?.contextId,
      usedPreviousResponseId: !!previousResponseId
    });

    return result;
  }

  /**
   * Complete using the legacy Chat Completions API
   */
  private async completeWithChatCompletions(prompt: string, options?: TextGenerationOptions): Promise<string> {
    let messages: Array<{ role: string; content: string }> = [];

    // If contextId is provided, build messages from conversation history
    if (options?.contextId) {
      const context = await contextManager.getContext(options.contextId);
      if (context) {
        // Convert conversation history to OpenAI messages format
        messages = context.conversationHistory.map(entry => ({
          role: entry.role,
          content: entry.content
        }));

        // Add current user prompt to context
        await contextManager.addConversationEntry(
          options.contextId,
          'user',
          prompt,
          options.contextId // Use contextId as step identifier
        );
      }
      
      // Add current user message
      messages.push({
        role: 'user',
        content: prompt
      });
    } else {
      // No context, just use the prompt as a user message
      messages = [
        {
          role: 'user',
          content: prompt
        }
      ];
    }    const requestBody: OpenAIChatRequestBody = {
      model: options?.model || this.model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature || 0.7,
      top_p: options?.topP || 1,
      stop: options?.stopSequences
    };    // Configure JSON schema if provided
    if (options?.jsonSchema) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'story_outline',
          description: 'Story outline structure',
          schema: options.jsonSchema as Record<string, unknown>
        }
      };
    }

    // DEBUG: Log the exact request being sent to OpenAI Chat Completions API
    logger.info('OpenAI Chat Completions API Debug - Request Details', {
      model: requestBody.model,
      messagesCount: requestBody.messages.length,
      messagesPreview: requestBody.messages.map((msg: any) => ({
        role: msg.role,
        contentLength: msg.content.length,
        contentPreview: msg.content.substring(0, 200) + '...'
      })),
      temperature: requestBody.temperature,
      maxTokens: requestBody.max_tokens,
      hasJsonSchema: !!requestBody.response_format,
      contextId: options?.contextId
    });

    // For full debugging, log the complete request
    if (process.env.DEBUG_AI_FULL_PROMPTS === 'true') {
      logger.debug('OpenAI Chat Completions API Debug - Full Request', {
        requestBody,
        contextId: options?.contextId
      });
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error('OpenAI Chat Completions API Debug - Request Failed', {
        status: response.status,
        statusText: response.statusText,
        errorData,
        requestPreview: JSON.stringify(requestBody).substring(0, 500),
        contextId: options?.contextId
      });
      throw new Error(`OpenAI API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    
    // DEBUG: Log the raw response from OpenAI Chat Completions API
    logger.info('OpenAI Chat Completions API Debug - Response Details', {
      hasChoices: !!data.choices,
      choicesCount: data.choices?.length || 0,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage,
      contextId: options?.contextId
    });

    // For full debugging, log the complete response
    if (process.env.DEBUG_AI_FULL_RESPONSES === 'true') {
      logger.debug('OpenAI Chat Completions API Debug - Full Response', {
        fullResponse: data,
        contextId: options?.contextId
      });
    }

    const result = data.choices?.[0]?.message?.content;

    if (!result) {
      logger.error('OpenAI Chat Completions API Debug - No text in response', {
        data,
        choices: data.choices,
        contextId: options?.contextId
      });
      throw new Error('No text generated from OpenAI');
    }

    // DEBUG: Log the extracted result
    logger.info('OpenAI Chat Completions API Debug - Extracted Result', {
      resultLength: result.length,
      resultPreview: result.substring(0, 300) + '...',
      startsWithBackticks: result.startsWith('```'),
      containsJsonMarkers: result.includes('```json') || result.includes('```'),
      firstChar: result.charAt(0),
      lastChar: result.charAt(result.length - 1),
      contextId: options?.contextId
    });

    // Add assistant response to context if contextId provided
    if (options?.contextId) {
      await contextManager.addConversationEntry(
        options.contextId,
        'assistant',
        result,
        options.contextId
      );
    }

    logger.debug('OpenAI Chat Completions text generation completed', {
      promptLength: prompt.length,
      responseLength: result.length,
      tokensUsed: data.usage,
      contextId: options?.contextId,
      usedContext: options?.contextId ? true : false,
      messagesCount: messages.length
    });

    return result;
  }
}
