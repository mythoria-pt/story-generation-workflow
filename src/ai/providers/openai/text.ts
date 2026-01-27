/**
 * OpenAI Text Generation Service - Responses API Only
 */

import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { getMaxOutputTokens } from '@/ai/model-limits.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export interface OpenAITextConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

interface OpenAIResponsesRequestBody {
  model: string;
  input: Array<{
    role: string;
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
  text: {
    format: {
      type: string;
      name?: string;
      strict?: boolean;
      schema?: Record<string, unknown>;
    };
  };
  reasoning: Record<string, unknown>;
  temperature: number;
  max_output_tokens: number;
  top_p: number;
  store: boolean;
  tools?: Array<{
    type: string;
    size?: string;
    quality?: string;
    output_format?: string;
    background?: string;
    moderation?: string;
    partial_images?: number;
  }>;
  previous_response_id?: string;
  stop?: string[];
}

interface OpenAIResponseOutput {
  type: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

interface OpenAIResponseData {
  id: string;
  output?: OpenAIResponseOutput[];
}

export class OpenAITextService implements ITextGenerationService {
  private apiKey: string;
  private model: string;
  private baseURL: string;

  constructor(config: OpenAITextConfig) {
    this.apiKey = config.apiKey;
    this.model =
      config.model || process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.2';
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';

    logger.info('OpenAI Text Service initialized (Responses API only)', {
      model: this.model,
      baseURL: this.baseURL,
    });
  } /**
   * Initialize context for a story generation session
   */
  async initializeContext(
    contextId: string,
    systemPrompt: string,
    previousContent?: string[],
  ): Promise<void> {
    try {
      // For Responses API, we can make an initial call to establish context
      // and get a response_id for future conversation continuity
      try {
        const response = await this.complete(
          'Please acknowledge that you understand the context and are ready to help.',
          { contextId },
        );

        logger.debug('Initial context established with Responses API', {
          contextId,
          responseLength: response.length,
        });
      } catch (error) {
        logger.warn(
          'Failed to establish initial context with Responses API, will continue without pre-initialization',
          {
            contextId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      logger.info('OpenAI context initialized', {
        contextId,
        systemPromptLength: systemPrompt.length,
        previousContentLength: previousContent?.length || 0,
      });
    } catch (error) {
      logger.error('Failed to initialize OpenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId,
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
        contextId,
      });
      throw error;
    }
  }
  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      return await this.completeWithResponsesAPI(prompt, options);
    } catch (error) {
      logger.error('OpenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        promptLength: prompt.length,
        contextId: options?.contextId,
      });
      throw error;
    }
  }
  /**
   * Complete using the new Responses API
   */ private async completeWithResponsesAPI(
    prompt: string,
    options?: TextGenerationOptions,
  ): Promise<string> {
    // Build input messages - with stateful API, we only need the system prompt and current user message
    const input = [];
    let previousResponseId: string | undefined;

    // Get system prompt and previous response ID for stateful conversation
    if (options?.contextId) {
      const context = await contextManager.getContext(options.contextId);
      if (context) {
        // Add system message (only needed for the first request)
        if (!context.providerSpecificData.openai?.responseId) {
          input.push({
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: context.systemPrompt,
              },
            ],
          });
        }

        // Get previous response_id for stateful conversation continuity
        previousResponseId = context.providerSpecificData.openai?.responseId;
      }
    }

    // Add current user message
    input.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: prompt,
        },
      ],
    });

    const maxOut = options?.maxTokens || getMaxOutputTokens(options?.model || this.model);
    const requestBody: OpenAIResponsesRequestBody = {
      model: options?.model || this.model,
      input,
      text: {
        format: {
          type: 'text',
        },
      },
      reasoning: {},
      temperature: options?.temperature || 1,
      max_output_tokens: maxOut,
      top_p: 1,
      store: true,
    };
    // Configure JSON schema if provided
    if (options?.jsonSchema) {
      requestBody.text.format = {
        type: 'json_schema',
        name: 'story_outline',
        strict: true,
        schema: options.jsonSchema as Record<string, unknown>,
      };
    }

    // Add previous_response_id for conversation continuity
    if (previousResponseId) {
      requestBody.previous_response_id = previousResponseId;
    } // Add stop sequences if provided
    if (options?.stopSequences) {
      requestBody.stop = options.stopSequences;
    } // DEBUG: Log the exact request being sent to OpenAI Responses API
    logger.info('OpenAI Responses API Debug - Request Details', {
      model: requestBody.model,
      inputLength: requestBody.input.length,
      inputPreview: JSON.stringify(requestBody.input).substring(0, 300) + '...',
      temperature: requestBody.temperature,
      maxOutputTokens: requestBody.max_output_tokens,
      hasJsonSchema: !!requestBody.text.format.schema,
      hasPreviousResponseId: !!requestBody.previous_response_id,
      contextId: options?.contextId,
    });

    // For full debugging, log the complete request
    if (process.env.DEBUG_AI_FULL_PROMPTS === 'true') {
      logger.debug('OpenAI Responses API Debug - Full Request', {
        requestBody,
        contextId: options?.contextId,
      });
    }

    const response = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error('OpenAI Responses API Debug - Request Failed', {
        status: response.status,
        statusText: response.statusText,
        errorData,
        requestPreview: JSON.stringify(requestBody).substring(0, 500),
        contextId: options?.contextId,
      });
      throw new Error(`OpenAI Responses API error: ${response.status} - ${errorData}`);
    }

    const data: OpenAIResponseData = await response.json();

    // DEBUG: Log the raw response from OpenAI Responses API
    logger.info('OpenAI Responses API Debug - Response Details', {
      responseId: data.id,
      hasOutput: !!data.output,
      outputLength: data.output?.length || 0,
      outputTypes: data.output?.map((item) => item.type) || [],
      contextId: options?.contextId,
    });

    // For full debugging, log the complete response
    if (process.env.DEBUG_AI_FULL_RESPONSES === 'true') {
      logger.debug('OpenAI Responses API Debug - Full Response', {
        fullResponse: data,
        contextId: options?.contextId,
      });
    }

    // Extract text content from the new response format
    const outputMessage = data.output?.find((item) => item.type === 'message');
    const textContent = outputMessage?.content?.find((content) => content.type === 'output_text');
    const result = textContent?.text;

    if (!result) {
      logger.error('OpenAI Responses API Debug - No text in response', {
        data,
        outputMessage,
        textContent,
        contextId: options?.contextId,
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
      contextId: options?.contextId,
    }); // Store response_id for future stateful conversation continuity
    if (options?.contextId && data.id) {
      const context = await contextManager.getContext(options.contextId);
      if (context) {
        await contextManager.updateProviderData(options.contextId, {
          openai: {
            responseId: data.id,
          },
        });
      }
    }

    logger.debug('OpenAI Responses API text generation completed', {
      promptLength: prompt.length,
      responseLength: result.length,
      responseId: data.id,
      contextId: options?.contextId,
      usedPreviousResponseId: !!previousResponseId,
    });
    return result;
  }
}
