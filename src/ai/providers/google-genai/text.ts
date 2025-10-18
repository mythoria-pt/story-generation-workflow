/**
 * Google GenAI Text Generation Service
 */

// Switched to @google/genai package
import { GoogleGenAI } from '@google/genai';
import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { getMaxOutputTokens } from '@/ai/model-limits.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export interface GoogleGenAITextConfig {
  apiKey: string;
  model?: string;
}

interface JsonSchemaType {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchemaType>;
  items?: JsonSchemaType;
  required?: string[];
  enum?: unknown[];
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  minLength?: number;
  [key: string]: unknown;
}

interface GenAISchemaType {
  type: string;
  description?: string;
  properties?: Record<string, GenAISchemaType>;
  items?: GenAISchemaType;
  required?: string[];
  enum?: unknown[];
  propertyOrdering?: string[];
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  minLength?: number;
}

export class GoogleGenAITextService implements ITextGenerationService {
  private genAI: any;
  private model: string;

  /**
   * Extract structured Google API / GenAI error information if present.
   * The @google/genai client (and underlying fetch) may surface errors in different shapes:
   * - error.cause.error (Vertex / REST style) { code, status, message, details[] }
   * - error.response.error
   * - direct { code, status, message }
   * We normalise these so callers / logs get actionable context.
   */
  private static extractGoogleError(err: unknown) {
    const out: Record<string, unknown> = {};
    const anyErr: any = err;
    const source = anyErr?.cause?.error || anyErr?.response?.error || anyErr?.error || anyErr;
    if (source) {
      if (source.code) out.code = source.code;
      if (source.status) out.status = source.status;
      if (source.message) out.apiMessage = source.message;
      if (Array.isArray(source.details) && source.details.length) {
        // Truncate very large details entries
        out.details = source.details.slice(0, 3);
      }
    }
    // Some SDK errors include status in message (e.g. "403 PERMISSION_DENIED: ...") – surface first token
    if (!out.status && typeof anyErr?.message === 'string') {
      const token = anyErr.message.split(/[ :]/)[0];
      if (token && token === token.toUpperCase() && token.length < 40) {
        out.statusGuess = token;
      }
    }
    return out;
  }

  constructor(config: GoogleGenAITextConfig) {
    this.genAI = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model || 'gemini-2.5-flash';

    // Backwards compatibility shim to mimic @google/generative-ai API used in rest of file
    const anyClient = this.genAI as any;
    if (typeof anyClient.getGenerativeModel !== 'function') {
      anyClient.getGenerativeModel = ({
        model,
        generationConfig,
        systemInstruction: _systemInstruction,
      }: {
        model: string;
        generationConfig?: any;
        systemInstruction?: string;
      }) => {
        // Note: systemInstruction is accepted but not used in this shim - could be passed to API call if needed
        return {
          generateContent: (input: any) => {
            // Normalize to { model, contents, config }
            if (typeof input === 'string') {
              return anyClient.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: input }] }],
                config: generationConfig,
              });
            }
            if (input && typeof input === 'object' && input.contents) {
              return anyClient.models.generateContent({
                model,
                ...input,
                config: generationConfig || input.config,
              });
            }
            return anyClient.models.generateContent({
              model,
              contents: [{ role: 'user', parts: [{ text: String(input) }] }],
              config: generationConfig,
            });
          },
          startChat: ({ history: _history }: { history?: any[] }) => {
            // Note: history is accepted but not used in this shim - stateless for now
            return {
              sendMessage: (prompt: string) =>
                anyClient.models.generateContent({
                  model,
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  config: generationConfig,
                }),
            };
          },
        };
      };
    }
    if (typeof anyClient.startChat !== 'function') {
      anyClient.startChat = ({
        model,
        generationConfig,
      }: {
        model: string;
        generationConfig?: any;
      }) => {
        return {
          sendMessage: (prompt: string) =>
            anyClient.models.generateContent({
              model,
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: generationConfig,
            }),
        };
      };
    }

    logger.info('Google GenAI Text Service initialized', {
      model: this.model,
    });
  }

  /**
   * Convert JSON Schema to Google GenAI Schema format
   */
  private convertJsonSchemaToGenAISchema(jsonSchema: unknown): GenAISchemaType {
    // Type guard to ensure we have a valid schema object
    if (!jsonSchema || typeof jsonSchema !== 'object') {
      throw new Error('Invalid JSON schema provided');
    }

    const schema = jsonSchema as JsonSchemaType;
    if (!schema.type || typeof schema.type !== 'string') {
      throw new Error('JSON schema must have a valid type property');
    }
    const convertType = (type: string) => {
      switch (type) {
        case 'string':
          return 'STRING';
        case 'integer':
          return 'INTEGER';
        case 'number':
          return 'NUMBER';
        case 'boolean':
          return 'BOOLEAN';
        case 'array':
          return 'ARRAY';
        case 'object':
          return 'OBJECT';
        default:
          return 'STRING';
      }
    };

    const convertSchema = (schema: JsonSchemaType): GenAISchemaType => {
      const result: GenAISchemaType = {
        type: convertType(schema.type),
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
            Object.keys(schema.properties).filter(
              (key) => schema.required && !schema.required.includes(key),
            ),
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

    return convertSchema(schema);
  }
  /**
   * Initialize context for a story generation session
   * Creates a stateful chat instance using Google GenAI's ai.chats API
   */
  async initializeContext(contextId: string, systemPrompt: string): Promise<void> {
    try {
      logger.info('Google GenAI Debug - Initializing context', {
        contextId,
        systemPromptLength: systemPrompt.length,
        model: this.model,
        hasGetGenerativeModel: typeof this.genAI.getGenerativeModel === 'function',
      });

      // Create a chat instance for stateful conversations
      const generativeModel = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: systemPrompt,
      });

      logger.info('Google GenAI Debug - Created generative model', {
        contextId,
        hasStartChat: typeof generativeModel.startChat === 'function',
        modelMethods: Object.getOwnPropertyNames(generativeModel),
      });

      const chat = generativeModel.startChat({
        history: [], // Start with empty history, system prompt is handled by systemInstruction
        generationConfig: {
          maxOutputTokens: getMaxOutputTokens(this.model),
        },
      });

      // Store the chat instance in context manager
      const context = await contextManager.getContext(contextId);
      if (context) {
        await contextManager.updateProviderData(contextId, {
          googleGenAI: {
            chatInstance: chat,
          },
        });
      }

      logger.info('Google GenAI chat context initialized', {
        contextId,
        model: this.model,
      });
    } catch (error) {
      logger.error('Failed to initialize Google GenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId,
        stack: error instanceof Error ? error.stack : undefined,
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
            chatInstance: undefined,
          },
        });

        logger.info('Google GenAI context cleared', {
          contextId,
        });
      }
    } catch (error) {
      logger.error('Failed to clear Google GenAI context', {
        error: error instanceof Error ? error.message : String(error),
        contextId,
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
              // Use caller override OR model maximum
              maxOutputTokens:
                options?.maxTokens || getMaxOutputTokens(options?.model || this.model),
              temperature: options?.temperature || 0.7,
              topP: options?.topP || 0.9,
              topK: options?.topK || 40,
              ...(options?.stopSequences && { stopSequences: options.stopSequences }),
              responseMimeType: 'application/json',
              responseSchema: this.convertJsonSchemaToGenAISchema(options.jsonSchema),
            };

            const generativeModel = this.genAI.getGenerativeModel({
              model: options?.model || this.model,
              generationConfig,
            });

            logger.info('Google GenAI Debug - Using structured output with context', {
              contextId: options.contextId,
              model: this.model,
              hasJsonSchema: true,
            });

            if (options?.mediaParts && options.mediaParts.length > 0) {
              // Build content parts with media attachments
              const parts: any[] = [{ text: prompt }];
              for (const mp of options.mediaParts) {
                if (typeof mp.data === 'string') {
                  parts.push({
                    inlineData: {
                      data: Buffer.from(mp.data).toString('base64'),
                      mimeType: mp.mimeType,
                    },
                  });
                } else {
                  parts.push({
                    inlineData: { data: mp.data.toString('base64'), mimeType: mp.mimeType },
                  });
                }
              }
              response = await generativeModel.generateContent({
                contents: [{ role: 'user', parts }],
              });
            } else {
              response = await generativeModel.generateContent(prompt);
            }
          } else {
            // Use existing chat instance for stateful conversation without JSON schema
            logger.info('Google GenAI Debug - Using stateful chat', {
              contextId: options.contextId,
              model: this.model,
            });

            response = await chat.sendMessage(prompt);
          }
        }
      }
      // If no chat instance exists, create a new one for stateless generation
      if (!response) {
        const generationConfig: any = {
          maxOutputTokens: options?.maxTokens || getMaxOutputTokens(options?.model || this.model),
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
            hasSchema: true,
            contextId: options?.contextId,
          });
        }

        const generativeModel = this.genAI.getGenerativeModel({
          model: options?.model || this.model,
          generationConfig,
        });

        logger.info('Google GenAI Debug - Using stateless generation', {
          model: options?.model || this.model,
          contextId: options?.contextId || 'none',
          hasJsonSchema: !!options?.jsonSchema,
          hasMediaParts: !!options?.mediaParts && options.mediaParts.length > 0,
        });

        // If media parts are provided, send as inlineData parts alongside the prompt
        if (options?.mediaParts && options.mediaParts.length > 0) {
          const parts: any[] = [{ text: prompt }];
          for (const mp of options.mediaParts) {
            if (typeof mp.data === 'string') {
              parts.push({
                inlineData: {
                  data: Buffer.from(mp.data).toString('base64'),
                  mimeType: mp.mimeType,
                },
              });
            } else {
              parts.push({
                inlineData: { data: mp.data.toString('base64'), mimeType: mp.mimeType },
              });
            }
          }
          response = await generativeModel.generateContent({ contents: [{ role: 'user', parts }] });
        } else {
          response = await generativeModel.generateContent(prompt);
        }
      }

      // Extract the text response
      const raw = response as any;
      const candidateList = raw?.response?.candidates || raw?.candidates;
      const firstCandidate = Array.isArray(candidateList) ? candidateList[0] : undefined;
      if (!firstCandidate) {
        throw new Error('No candidates returned from Google GenAI');
      }

      // Try to extract text from first candidate; if empty, scan other candidates
      const collectCandidateParts = (cand: any): any[] => {
        if (!cand) return [];
        const parts: any[] = [];

        const includeParts = (input: any) => {
          if (!input) return;
          if (Array.isArray(input)) {
            for (const item of input) {
              if (!item) continue;
              if (Array.isArray(item.parts)) {
                parts.push(...item.parts);
              } else if (item.parts) {
                parts.push(item.parts);
              } else if (item.text || item.inlineData) {
                parts.push(item);
              }
            }
            return;
          }

          if (Array.isArray(input.parts)) {
            parts.push(...input.parts);
            return;
          }

          if (input.text || input.inlineData) {
            parts.push(input);
          }
        };

        includeParts(cand.parts);
        includeParts(cand.content);
        includeParts(cand?.content?.parts);

        return parts;
      };

      const extractTextFromCandidate = (cand: any): string | undefined => {
        const parts = collectCandidateParts(cand);
        const textChunks = parts
          .map((p: any) => p?.text)
          .filter((t: any): t is string => typeof t === 'string' && t.length > 0);
        if (textChunks.length > 0) {
          return textChunks.join('\n');
        }

        const directText = cand?.outputText || cand?.output_text || cand?.text;
        if (typeof directText === 'string' && directText.length > 0) {
          return directText;
        }

        return undefined;
      };

      let textContent = extractTextFromCandidate(firstCandidate);
      if (!textContent && Array.isArray(candidateList) && candidateList.length > 1) {
        for (let i = 1; i < candidateList.length; i++) {
          textContent = extractTextFromCandidate(candidateList[i]);
          if (textContent) {
            logger.warn('Google GenAI Debug - Fallback to later candidate with text', {
              pickedIndex: i,
              totalCandidates: candidateList.length,
            });
            break;
          }
        }
      }
      if (!textContent && typeof (raw?.response?.text) === 'string' && raw.response.text.length > 0) {
        textContent = raw.response.text;
      }
      if (!textContent) {
        const candidate = firstCandidate; // for diagnostics naming
        const finishReason = candidate.finishReason;
        const safety = candidate.safetyRatings || candidate.safety || candidate.safetyFeedback;
        const candidateParts = collectCandidateParts(candidate);
        const partDiagnostics = candidateParts.map((p: any) => ({
          keys: Object.keys(p ?? {}),
          hasText: !!p?.text,
          hasInlineData: !!p?.inlineData,
          mime: p?.inlineData?.mimeType,
        }));
        logger.error('Google GenAI Debug - No text content. Raw candidate snapshot', {
          hasResponse: !!(response as any).response,
          finishReason,
          safetyRatings: safety,
          partDiagnostics,
          candidateKeys: Object.keys(candidate || {}),
          model: options?.model || this.model,
          totalCandidates: Array.isArray(candidateList) ? candidateList.length : 1,
        });
        const reasonHint = finishReason ? ` finishReason=${finishReason}` : '';
        throw new Error('No text content in Google GenAI response.' + reasonHint);
      }

      logger.info('Google GenAI Debug - Response received', {
        model: options?.model || this.model,
        responseLength: textContent.length,
        contextId: options?.contextId,
      });

      return textContent;
    } catch (error) {
      const structured = GoogleGenAITextService.extractGoogleError(error);
      logger.error('Google GenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        ...structured,
        promptLength: prompt.length,
        model: options?.model || this.model,
        contextId: options?.contextId,
        // Provide a short prompt preview for correlation (avoid logging entire prompt for cost & potential PII)
        promptPreview: prompt.slice(0, 160),
      });
      // Re-wrap with additional context while preserving original stack / message
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(String(error));
      }
    }
  }
}
