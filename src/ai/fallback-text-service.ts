import { ITextGenerationService, TextGenerationOptions } from '@/ai/interfaces.js';
import { logger } from '@/config/logger.js';
import { isSafetyBlockError } from '@/shared/retry-utils.js';

export class FallbackTextGenerationService implements ITextGenerationService {
  private primary: ITextGenerationService;
  private fallback: ITextGenerationService;
  private primaryName: string;
  private fallbackName: string;
  private fallbackModel: string;

  constructor(params: {
    primary: ITextGenerationService;
    fallback: ITextGenerationService;
    primaryName: string;
    fallbackName: string;
    fallbackModel: string;
  }) {
    this.primary = params.primary;
    this.fallback = params.fallback;
    this.primaryName = params.primaryName;
    this.fallbackName = params.fallbackName;
    this.fallbackModel = params.fallbackModel;
  }

  async complete(prompt: string, options?: TextGenerationOptions): Promise<string> {
    try {
      return await this.primary.complete(prompt, options);
    } catch (err) {
      const safetyBlocked = isSafetyBlockError(err);
      if (!safetyBlocked) {
        throw err;
      }

      logger.warn('Primary text provider safety blocked – attempting fallback', {
        primary: this.primaryName,
        fallback: this.fallbackName,
        reason: err instanceof Error ? err.message : String(err),
        contextId: options?.contextId,
      });

      const fallbackOptions: TextGenerationOptions = {
        ...(options || {}),
        model: this.fallbackModel,
      };

      try {
        const result = await this.fallback.complete(prompt, fallbackOptions);
        logger.info('Fallback text provider succeeded after safety block', {
          primary: this.primaryName,
          fallback: this.fallbackName,
          contextId: options?.contextId,
          promptLength: prompt.length,
        });
        return result;
      } catch (fallbackErr) {
        const fallbackSafetyBlocked = isSafetyBlockError(fallbackErr);

        if (!fallbackSafetyBlocked) {
          try {
            (fallbackErr as any).fallbackAttempted = true;
            (fallbackErr as any).originalSafetyBlocked = true;
            (fallbackErr as any).originalSafetyMessage =
              err instanceof Error ? err.message : String(err);
          } catch {
            // Ignore enrichment failures
          }

          logger.error('Fallback text provider failed (non-safety) after safety block', {
            primary: this.primaryName,
            fallback: this.fallbackName,
            originalSafety: err instanceof Error ? err.message : String(err),
            fallbackError:
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            contextId: options?.contextId,
          });

          throw fallbackErr;
        }

        try {
          (err as any).fallbackAttempted = true;
          (err as any).fallbackError =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        } catch {
          // Ignore enrichment failures
        }

        logger.error('Fallback text provider also safety blocked', {
          primary: this.primaryName,
          fallback: this.fallbackName,
          originalError: err instanceof Error ? err.message : String(err),
          fallbackError:
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          contextId: options?.contextId,
        });

        throw err;
      }
    }
  }

  async initializeContext?(
    contextId: string,
    systemPrompt: string,
    previousContent?: string[],
  ): Promise<void> {
    if (this.primary.initializeContext) {
      await this.primary.initializeContext(contextId, systemPrompt, previousContent);
    }
  }

  async clearContext?(contextId: string): Promise<void> {
    if (this.primary.clearContext) {
      await this.primary.clearContext(contextId);
    }
  }
}
