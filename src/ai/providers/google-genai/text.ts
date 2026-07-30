/**
 * Google GenAI Text Generation Service
 */

import {
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import { ITextGenerationService, TextGenerationOptions } from '../../interfaces.js';
import { getMaxOutputTokens } from '@/ai/model-limits.js';
import { contextManager } from '../../context-manager.js';
import { logger } from '@/config/logger.js';

export interface GoogleGenAITextConfig {
  apiKey: string;
  model?: string;
}

export class GoogleGenAITextService implements ITextGenerationService {
  private genAI: GoogleGenAI;
  private model: string;

  private static sanitizeErrorPayload(
    value: unknown,
    depth: number = 0,
    seen: WeakSet<object> = new WeakSet(),
  ): unknown {
    if (value == null) {
      return value;
    }

    if (typeof value === 'string') {
      return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'object') {
      return String(value);
    }

    if (seen.has(value as object)) {
      return '[Circular]';
    }

    if (depth >= 4) {
      return '[TruncatedDepth]';
    }

    seen.add(value as object);

    if (Array.isArray(value)) {
      return value
        .slice(0, 10)
        .map((entry) => GoogleGenAITextService.sanitizeErrorPayload(entry, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = GoogleGenAITextService.sanitizeErrorPayload(entry, depth + 1, seen);
    }

    return out;
  }

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

  private static extractGoogleErrorPayload(err: unknown): unknown {
    const anyErr: any = err;
    const source = anyErr?.cause?.error || anyErr?.response?.error || anyErr?.error;
    if (!source) {
      return undefined;
    }

    return GoogleGenAITextService.sanitizeErrorPayload(source);
  }

  constructor(config: GoogleGenAITextConfig) {
    this.genAI = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model || 'gemini-3.6-flash';

    logger.info('Google GenAI Text Service initialized', {
      model: this.model,
    });
  }

  private buildUserParts(prompt: string, mediaParts?: TextGenerationOptions['mediaParts']): Part[] {
    const parts: Part[] = [{ text: prompt }];
    for (const mediaPart of mediaParts ?? []) {
      parts.push({
        inlineData: {
          data:
            typeof mediaPart.data === 'string'
              ? Buffer.from(mediaPart.data).toString('base64')
              : mediaPart.data.toString('base64'),
          mimeType: mediaPart.mimeType,
        },
      });
    }
    return parts;
  }

  private buildUserContent(
    prompt: string,
    mediaParts?: TextGenerationOptions['mediaParts'],
  ): Content {
    return {
      role: 'user',
      parts: this.buildUserParts(prompt, mediaParts),
    };
  }

  private buildGenerationConfig(
    options?: TextGenerationOptions,
    cachedContent?: string,
    contextSystemInstruction?: string,
  ): GenerateContentConfig {
    const targetModel = (options?.model || this.model).toLowerCase();
    const config: GenerateContentConfig = {
      maxOutputTokens: options?.maxTokens || getMaxOutputTokens(targetModel),
      ...(options?.stopSequences && { stopSequences: options.stopSequences }),
      ...(cachedContent && { cachedContent }),
      ...(options?.googleSearchGrounding && { tools: [{ googleSearch: {} }] }),
    };

    const systemInstruction = options?.systemInstruction || contextSystemInstruction;
    if (systemInstruction && !cachedContent) {
      config.systemInstruction = systemInstruction;
    }

    if (targetModel.startsWith('gemini-3') && options?.thinkingLevel) {
      const thinkingLevels = {
        minimal: ThinkingLevel.MINIMAL,
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        high: ThinkingLevel.HIGH,
      } as const;
      config.thinkingConfig = {
        thinkingLevel: thinkingLevels[options.thinkingLevel],
      };
    }

    if (options?.mediaResolution) {
      const mediaResolutions = {
        low: MediaResolution.MEDIA_RESOLUTION_LOW,
        medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        high: MediaResolution.MEDIA_RESOLUTION_HIGH,
      } as const;
      config.mediaResolution = mediaResolutions[options.mediaResolution];
    }

    if (options?.jsonSchema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = options.jsonSchema;
    }

    return config;
  }
  /**
   * Initialize context for a story generation session
   * Creates a stateful chat instance using Google GenAI's ai.chats API
   * Also creates an explicit cached content object to reduce repeated input token costs.
   */
  async initializeContext(
    contextId: string,
    systemPrompt: string,
    previousContent?: string[],
  ): Promise<void> {
    try {
      logger.info('Google GenAI Debug - Initializing context', {
        contextId,
        systemPromptLength: systemPrompt.length,
        previousContentLength: previousContent?.length || 0,
        model: this.model,
        hasNativeChatsApi: typeof this.genAI.chats.create === 'function',
      });

      // ── Explicit context caching ──────────────────────────────────────
      // Cache the system prompt and previous content so subsequent calls
      // avoid re-sending it as input tokens. The cache has a 30-minute
      // TTL, matching a typical story-generation session lifetime.
      let cachedContentName: string | undefined;

      // Only attempt explicit caching if we have contents to cache.
      // The API requires a non-empty contents array even when systemInstruction is provided.
      if (previousContent && previousContent.length > 0) {
        try {
          // Cached content is a user-authored prefix. Never end a request prefix
          // with a prefilled model turn, which Gemini 3.6 rejects.
          const contents: Content[] = [
            {
              role: 'user',
              parts: [{ text: previousContent.join('\n\n') }],
            },
          ];

          const cacheResult = await this.genAI.caches.create({
            model: this.model,
            config: {
              displayName: `story-ctx-${contextId.substring(0, 8)}`,
              systemInstruction: systemPrompt,
              contents,
              ttl: '1800s', // 30 minutes
            },
          });
          cachedContentName = cacheResult?.name;
          if (cachedContentName) {
            logger.info('Google GenAI - Explicit context cache created', {
              contextId,
              cacheName: cachedContentName,
              model: this.model,
              contentsCount: contents.length,
            });
          }
        } catch (cacheError) {
          // Context caching is an optimisation; if it fails we fall back to
          // the normal flow without caching.
          logger.warn('Google GenAI - Failed to create context cache, continuing without caching', {
            contextId,
            error: cacheError instanceof Error ? cacheError.message : String(cacheError),
          });
        }
      } else {
        logger.info('Google GenAI - Skipping explicit context cache (no initial content)', {
          contextId,
        });
      }

      // Create a native SDK chat with no prefilled model turn.
      const chatConfig: GenerateContentConfig = {
        maxOutputTokens: getMaxOutputTokens(this.model),
        ...(cachedContentName
          ? { cachedContent: cachedContentName }
          : { systemInstruction: systemPrompt }),
      };
      const chat = this.genAI.chats.create({
        model: this.model,
        config: chatConfig,
        history: [],
      });

      logger.info('Google GenAI Debug - Created native chat', {
        contextId,
        model: this.model,
        hasCachedContent: !!cachedContentName,
      });

      // Store the chat instance and cache name in context manager
      const context = await contextManager.getContext(contextId);
      if (context) {
        await contextManager.updateProviderData(contextId, {
          googleGenAI: {
            chatInstance: chat,
            ...(cachedContentName ? { cachedContentName } : {}),
          },
        });
      }

      logger.info('Google GenAI chat context initialized', {
        contextId,
        model: this.model,
        hasCachedContent: !!cachedContentName,
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

      // Delete the explicit context cache if one was created
      const cacheName = context?.providerSpecificData.googleGenAI?.cachedContentName;
      if (cacheName) {
        try {
          await this.genAI.caches.delete({ name: cacheName });
          logger.info('Google GenAI - Explicit context cache deleted', {
            contextId,
            cacheName,
          });
        } catch (cacheDeleteError) {
          // Cache may have already expired (TTL); log and continue
          logger.warn('Google GenAI - Failed to delete context cache (may have expired)', {
            contextId,
            cacheName,
            error:
              cacheDeleteError instanceof Error
                ? cacheDeleteError.message
                : String(cacheDeleteError),
          });
        }
      }

      if (context?.providerSpecificData.googleGenAI?.chatInstance) {
        // Clear the chat instance reference and cache name
        await contextManager.updateProviderData(contextId, {
          googleGenAI: {},
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
      let response: unknown;
      let cachedContentForRequest: string | undefined;
      let contextSystemInstruction: string | undefined;

      if (options?.contextId) {
        const context = await contextManager.getContext(options.contextId);
        cachedContentForRequest = context?.providerSpecificData.googleGenAI?.cachedContentName;
        contextSystemInstruction = context?.systemPrompt;
        const chat = context?.providerSpecificData.googleGenAI?.chatInstance;

        if (chat) {
          if (options.jsonSchema) {
            const generationConfig = this.buildGenerationConfig(
              options,
              cachedContentForRequest,
              contextSystemInstruction,
            );

            logger.info('Google GenAI Debug - Using structured output with context', {
              contextId: options.contextId,
              model: options.model || this.model,
              hasJsonSchema: true,
            });

            response = await this.genAI.models.generateContent({
              model: options.model || this.model,
              contents: this.buildUserContent(prompt, options.mediaParts),
              config: generationConfig,
            });
          } else {
            logger.info('Google GenAI Debug - Using stateful chat', {
              contextId: options.contextId,
              model: options.model || this.model,
            });

            response = await chat.sendMessage({
              message: this.buildUserParts(prompt, options.mediaParts),
              config: this.buildGenerationConfig(
                options,
                cachedContentForRequest,
                contextSystemInstruction,
              ),
            });

            const rawCheck = response as any;
            const candidatesCheck = rawCheck?.response?.candidates || rawCheck?.candidates;
            const firstCandCheck = Array.isArray(candidatesCheck) ? candidatesCheck[0] : undefined;
            const hasContent = firstCandCheck?.content?.parts?.some(
              (part: any) => part?.text?.length > 0,
            );

            if (!hasContent) {
              logger.warn(
                'Google GenAI Debug - Empty chat response, falling back to stateless generation',
                {
                  contextId: options.contextId,
                  model: options.model || this.model,
                  finishReason: firstCandCheck?.finishReason,
                },
              );

              response = await this.genAI.models.generateContent({
                model: options.model || this.model,
                contents: this.buildUserContent(prompt, options.mediaParts),
                config: this.buildGenerationConfig(
                  options,
                  cachedContentForRequest,
                  contextSystemInstruction,
                ),
              });
            }
          }
        }
      }

      if (!response) {
        const generationConfig = this.buildGenerationConfig(options);

        logger.info('Google GenAI Debug - Using stateless generation', {
          model: options?.model || this.model,
          contextId: options?.contextId || 'none',
          hasJsonSchema: !!options?.jsonSchema,
          hasMediaParts: !!options?.mediaParts && options.mediaParts.length > 0,
          thinkingLevel: options?.thinkingLevel,
        });

        response = await this.genAI.models.generateContent({
          model: options?.model || this.model,
          contents: this.buildUserContent(prompt, options?.mediaParts),
          config: generationConfig,
        });
      }

      // Extract the text response
      const raw = response as any;
      const candidateList = raw?.response?.candidates || raw?.candidates;
      const firstCandidate = Array.isArray(candidateList) ? candidateList[0] : undefined;
      const promptFeedback = raw?.response?.promptFeedback || raw?.promptFeedback;
      const blockReason = promptFeedback?.blockReason;
      if (!firstCandidate) {
        const directText = raw?.response?.text || raw?.text;
        if (typeof directText === 'string' && directText.length > 0) {
          logger.warn('Google GenAI Debug - No candidates array but direct text was present', {
            model: options?.model || this.model,
            contextId: options?.contextId,
            responseLength: directText.length,
          });
          return directText;
        }

        logger.error('Google GenAI Debug - No candidates returned', {
          model: options?.model || this.model,
          contextId: options?.contextId,
          blockReason,
          promptSafetyRatings: promptFeedback?.safetyRatings,
          modelStatus: raw?.response?.modelStatus || raw?.modelStatus,
          responseId: raw?.response?.responseId || raw?.responseId,
          hasPromptFeedback: !!promptFeedback,
        });

        if (blockReason) {
          const blockedError = new Error(
            `Google GenAI prompt blocked (blockReason=${blockReason}). Rephrase prompt.`,
          );
          (blockedError as any).code = blockReason;
          (blockedError as any).status = 422;
          (blockedError as any).provider = 'google-genai';
          (blockedError as any).promptFeedback = promptFeedback;
          throw blockedError;
        }

        throw new Error('No candidates returned from Google GenAI. Check promptFeedback.');
      }

      // Try to extract text from first candidate; if empty, scan other candidates
      const collectCandidateParts = (cand: any): any[] => {
        if (!cand) return [];

        const collected: any[] = [];
        const seen = new WeakSet<object>();

        const visit = (input: any): void => {
          if (!input) {
            return;
          }

          if (Array.isArray(input)) {
            if (seen.has(input)) {
              return;
            }
            seen.add(input);
            for (const item of input) {
              visit(item);
            }
            return;
          }

          if (typeof input === 'object') {
            if (input === null) {
              return;
            }

            if (seen.has(input)) {
              return;
            }
            seen.add(input);

            const obj: any = input;

            if (Array.isArray(obj.parts)) {
              visit(obj.parts);
              return;
            }

            if (obj.parts) {
              visit(obj.parts);
              return;
            }

            if (typeof obj.text === 'string' || obj.inlineData) {
              collected.push(obj);
              return;
            }

            if (typeof obj.outputText === 'string' || typeof obj.output_text === 'string') {
              collected.push({ text: obj.outputText ?? obj.output_text });
              return;
            }

            if (Array.isArray(obj.candidates)) {
              visit(obj.candidates);
            }

            if (Array.isArray(obj.contents)) {
              visit(obj.contents);
            }

            for (const value of Object.values(obj)) {
              if (typeof value === 'object') {
                visit(value);
              }
            }

            return;
          }

          if (typeof input === 'string' && input.trim().length > 0) {
            collected.push({ text: input });
          }
        };

        visit(cand.parts);
        visit(cand.content);

        return collected;
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
      if (!textContent && typeof raw?.response?.text === 'string' && raw.response.text.length > 0) {
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
          promptBlockReason: blockReason,
          promptSafetyRatings: promptFeedback?.safetyRatings,
          partDiagnostics,
          candidateKeys: Object.keys(candidate || {}),
          model: options?.model || this.model,
          totalCandidates: Array.isArray(candidateList) ? candidateList.length : 1,
        });
        const reasonHint = finishReason ? ` finishReason=${finishReason}` : '';
        throw new Error('No text content in Google GenAI response.' + reasonHint);
      }

      try {
        const usageMetadata = raw?.response?.usageMetadata;
        if (usageMetadata && options?.usageObserver) {
          const inputTokens = usageMetadata.promptTokenCount;
          const totalTokens = usageMetadata.totalTokenCount;
          const outputTokens =
            usageMetadata.candidatesTokenCount ??
            (typeof totalTokens === 'number' && typeof inputTokens === 'number'
              ? Math.max(totalTokens - inputTokens, 0)
              : undefined);

          options.usageObserver({
            provider: 'google-genai',
            inputTokens,
            outputTokens,
            totalTokens,
            billedUnits: usageMetadata.cachedContentTokenCount,
          });
        }
      } catch (usageError) {
        logger.warn('Failed to forward Google GenAI usage metadata', {
          error: usageError instanceof Error ? usageError.message : String(usageError),
          contextId: options?.contextId,
        });
      }

      logger.info('Google GenAI Debug - Response received', {
        model: options?.model || this.model,
        responseLength: textContent.length,
        contextId: options?.contextId,
      });

      return textContent;
    } catch (error) {
      const structured = GoogleGenAITextService.extractGoogleError(error);
      const googleErrorResponse = GoogleGenAITextService.extractGoogleErrorPayload(error);
      logger.error('Google GenAI text generation failed', {
        error: error instanceof Error ? error.message : String(error),
        ...structured,
        ...(googleErrorResponse ? { googleErrorResponse } : {}),
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
