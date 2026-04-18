import { IImageGenerationService, ImageGenerationOptions } from '@/ai/interfaces.js';
import { ImageGenerationBlockedError } from '@/ai/errors.js';
import { logger } from '@/config/logger.js';

/**
 * Composite image generation service that provides fallback behavior:
 * 1. Attempt primary provider (e.g. google-genai)
 * 2. If the primary fails for ANY reason (safety block, IMAGE_OTHER, transient,
 *    or persistent), attempt fallback provider (e.g. openai)
 * 3. If fallback succeeds, returns its buffer. If it fails, the most actionable
 *    error is rethrown with diagnostic flags so the HTTP layer can expose details.
 */
export class FallbackImageGenerationService implements IImageGenerationService {
  private primary: IImageGenerationService;
  private fallback: IImageGenerationService;
  private fallbackName: string;
  private primaryName: string;

  constructor(params: {
    primary: IImageGenerationService;
    fallback: IImageGenerationService;
    primaryName: string;
    fallbackName: string;
  }) {
    this.primary = params.primary;
    this.fallback = params.fallback;
    this.primaryName = params.primaryName;
    this.fallbackName = params.fallbackName;
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<Buffer> {
    try {
      return await this.primary.generate(prompt, options);
    } catch (err) {
      const isSafetyBlocked =
        err instanceof ImageGenerationBlockedError ||
        (err instanceof Error && /PROHIBITED_CONTENT/.test(err.message));

      const errorCategory = isSafetyBlocked ? 'safety_block' : 'persistent_failure';

      logger.warn('Primary image provider failed, attempting fallback', {
        primary: this.primaryName,
        fallback: this.fallbackName,
        category: errorCategory,
        reason: err instanceof Error ? err.message : String(err),
        errorCode: (err as any)?.code,
      });

      try {
        const buffer = await this.fallback.generate(prompt, options);
        logger.info('Fallback image provider succeeded after primary failure', {
          primary: this.primaryName,
          fallback: this.fallbackName,
          category: errorCategory,
          promptLength: prompt.length,
          imageType: options?.imageType,
        });
        return buffer;
      } catch (fallbackErr) {
        const fallbackIsSafety =
          fallbackErr instanceof ImageGenerationBlockedError ||
          (fallbackErr instanceof Error && /PROHIBITED_CONTENT/.test(fallbackErr.message));

        if (isSafetyBlocked && fallbackIsSafety) {
          // Both providers safety blocked: attach info to original and rethrow
          try {
            (err as any).fallbackAttempted = true;
            (err as any).fallbackError =
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          } catch {
            /* ignore */
          }
          logger.error('Fallback image provider also safety blocked', {
            primary: this.primaryName,
            fallback: this.fallbackName,
            originalError: err instanceof Error ? err.message : String(err),
            fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          throw err;
        }

        // If primary was safety-blocked but fallback failed for a different reason,
        // propagate the fallback error (more actionable) with original context
        if (isSafetyBlocked) {
          try {
            (fallbackErr as any).fallbackAttempted = true;
            (fallbackErr as any).originalSafetyBlocked = true;
            (fallbackErr as any).originalSafetyMessage =
              err instanceof Error ? err.message : String(err);
          } catch {
            /* ignore */
          }
          logger.error('Fallback image provider failed (non-safety) after primary safety block', {
            primary: this.primaryName,
            fallback: this.fallbackName,
            originalSafety: err instanceof Error ? err.message : String(err),
            fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          throw fallbackErr;
        }

        // Primary was non-safety, fallback also failed: throw the more informative error
        try {
          (err as any).fallbackAttempted = true;
          (err as any).fallbackError =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        } catch {
          /* ignore */
        }
        logger.error('Both image providers failed (non-safety)', {
          primary: this.primaryName,
          fallback: this.fallbackName,
          primaryError: err instanceof Error ? err.message : String(err),
          fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        throw err;
      }
    }
  }
}
