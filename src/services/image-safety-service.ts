import { PromptService } from '@/services/prompt.js';
import { logger } from '@/config/logger.js';
import { buildSafeFallbackPrompt } from './image-prompt-utils.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { isSafetyBlockError } from '@/shared/retry-utils.js';

export interface ImageSafetyContext {
  storyId: string;
  runId?: string;
  chapterNumber?: number;
  imageType?: 'front_cover' | 'back_cover' | 'chapter';
  authorId: string;
  bookTitle?: string;
  graphicalStyle?: string;
}

export interface ImageSafetyResult {
  imageBuffer: Buffer;
  finalPrompt: string;
  promptRewriteAttempted: boolean;
  promptRewriteApplied: boolean;
  fallbackPromptUsed: boolean;
  promptRewriteError?: string;
  fallbackError?: string;
}

interface SafetyDependencies {
  aiGateway?: ReturnType<typeof getAIGatewayWithTokenTracking>;
}

export class ImageSafetyService {
  private readonly aiGateway: ReturnType<typeof getAIGatewayWithTokenTracking>;

  constructor(deps: SafetyDependencies = {}) {
    this.aiGateway = deps.aiGateway ?? getAIGatewayWithTokenTracking();
  }

  async handleSafetyBlock(params: {
    originalPrompt: string;
    safetyError: unknown;
    context: ImageSafetyContext;
    attemptImageGeneration: (prompt: string) => Promise<Buffer>;
  }): Promise<ImageSafetyResult> {
    const { originalPrompt, safetyError, context, attemptImageGeneration } = params;

    const result: ImageSafetyResult = {
      imageBuffer: Buffer.alloc(0),
      finalPrompt: originalPrompt,
      promptRewriteAttempted: false,
      promptRewriteApplied: false,
      fallbackPromptUsed: false,
    };

    // Step 1: try to rewrite the prompt
    result.promptRewriteAttempted = true;
    try {
      const rewritePromptTemplate = await PromptService.loadPrompt(
        'en-US',
        'image-prompt-safety-rewrite',
      );

      const rewriteVars = {
        safetyError: safetyError instanceof Error ? safetyError.message : String(safetyError),
        imageType: context.imageType || 'chapter',
        bookTitle: context.bookTitle,
        graphicalStyle: context.graphicalStyle || 'illustration',
        chapterNumber: context.chapterNumber?.toString() || '',
        originalPrompt,
      };

      const rewritePrompt = PromptService.buildPrompt(rewritePromptTemplate, rewriteVars);
      const textContext = {
        authorId: context.authorId,
        storyId: context.storyId,
        action: 'prompt_rewrite' as const,
      };

      const rewrittenPrompt = await this.aiGateway
        .getTextService(textContext)
        .complete(rewritePrompt, {
          temperature: 0.7,
          maxTokens: 65535,
        });

      result.finalPrompt = rewrittenPrompt.trim();

      if (result.finalPrompt.startsWith('UNABLE_TO_REWRITE:')) {
        throw new Error(
          'Prompt deemed unsafe and not eligible for rewrite; attempting sanitized fallback.',
        );
      }

      // Avoid burning another ~150s OpenAI call on a rewrite that's nearly
      // identical to the blocked original — it will almost certainly be
      // blocked again. Skip straight to the generic fallback in that case.
      if (isNearIdentical(result.finalPrompt, originalPrompt)) {
        throw new Error('Rewrite too similar to original prompt; skipping to safe fallback.');
      }

      const imageBuffer = await attemptImageGeneration(result.finalPrompt);
      result.imageBuffer = imageBuffer;
      result.promptRewriteApplied = true;
      return result;
    } catch (rewriteError) {
      result.promptRewriteError =
        rewriteError instanceof Error ? rewriteError.message : String(rewriteError);
      logger.error('Prompt rewrite failed, trying safe fallback', {
        storyId: context.storyId,
        runId: context.runId,
        imageType: context.imageType,
        chapterNumber: context.chapterNumber,
        error: result.promptRewriteError,
      });
    }

    // Step 2: try a sanitized fallback prompt (generic, no-people)
    try {
      result.fallbackPromptUsed = true;
      result.finalPrompt = buildSafeFallbackPrompt(originalPrompt, {
        ...(context.graphicalStyle ? { styleHint: context.graphicalStyle } : {}),
        ...(context.imageType ? { imageType: context.imageType } : {}),
        ...(context.chapterNumber !== undefined ? { chapterNumber: context.chapterNumber } : {}),
        ...(context.bookTitle ? { bookTitle: context.bookTitle } : {}),
      });
      result.imageBuffer = await attemptImageGeneration(result.finalPrompt);
      return result;
    } catch (fallbackError) {
      result.fallbackError =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      const enrichedError: any = safetyError;
      enrichedError.promptRewriteAttempted = true;
      if (result.promptRewriteError) enrichedError.promptRewriteError = result.promptRewriteError;
      enrichedError.fallbackAttempted = true;
      enrichedError.fallbackError = result.fallbackError;
      throw enrichedError;
    }
  }

  isSafetyBlock(error: unknown): boolean {
    return isSafetyBlockError(error);
  }
}

// Token-based Jaccard similarity. Returns true when the rewrite kept >=80% of
// the original prompt's tokens — that means the rewrite is cosmetic and the
// safety system will almost certainly block it again.
function isNearIdentical(a: string, b: string): boolean {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return false;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;

  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= 0.8;
}
