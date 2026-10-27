/**
 * Token Usage Tracking Service
 * Handles recording of AI API usage, token consumption, and cost estimation
 */

import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { tokenUsageTracking, InsertTokenUsage } from '@/db/workflows-db.js';
import { logger } from '@/config/logger.js';
import { eq, gte, lte, and } from 'drizzle-orm';
import {
  GOOGLE_FALLBACK_MODEL,
  GOOGLE_TTS_FALLBACK_MODEL,
  USD_TO_EUR,
  resolvePricing,
  type ImageQualityLevel,
  type ImageResolution,
  type PricingTier,
} from '@/services/model-pricing.js';

/** Models already warned about, so each unknown model is logged once per process. */
const warnedUnknownModels = new Set<string>();

/** Legacy 'standard'/'hd' values map to medium/high; 'auto' is billed as medium. */
export type ImageQualityInput = 'standard' | 'hd' | 'auto' | ImageQualityLevel;

export interface TokenUsageRequest {
  authorId: string;
  storyId: string;
  action:
    | 'story_structure'
    | 'story_outline'
    | 'chapter_writing'
    | 'image_generation'
    | 'story_review'
    | 'character_generation'
    | 'story_enhancement'
    | 'audio_generation'
    | 'content_validation'
    | 'image_edit'
    | 'prompt_rewrite'
    | 'blog_translation'
    | 'character_photo_analysis'
    | 'image_analysis'
    | 'email_asset_generation'
    | 'test';
  aiModel: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  imageQuality?: ImageQualityInput;
  imageSize?: string;
  /** Output tokens that were image tokens (vs text/thinking), when the provider reports the split. */
  imageOutputTokens?: number;
  inputPromptJson: Record<string, unknown>;
}

export interface CostEstimation {
  provider: 'openai' | 'google-genai' | 'unknown';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  imageQuality?: ImageQualityInput;
  imageSize?: string;
  imageOutputTokens?: number;
  /** Request time used to select dated pricing tiers; defaults to now. */
  timestamp?: Date;
  estimatedCostInEuros: number;
}

export class TokenUsageTrackingService {
  private db = getWorkflowsDatabase();

  /**
   * Record token usage from an AI API call
   */
  async recordUsage(request: TokenUsageRequest): Promise<void> {
    try {
      const costEstimationParams: CostEstimation = {
        provider: this.getProviderFromModel(request.aiModel),
        model: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        estimatedCostInEuros: 0, // Will be calculated
      };

      if (request.cachedInputTokens !== undefined) {
        costEstimationParams.cachedInputTokens = request.cachedInputTokens;
      }
      if (request.imageQuality !== undefined) {
        costEstimationParams.imageQuality = request.imageQuality;
      }
      if (request.imageSize !== undefined) {
        costEstimationParams.imageSize = request.imageSize;
      }
      if (request.imageOutputTokens !== undefined) {
        costEstimationParams.imageOutputTokens = request.imageOutputTokens;
      }

      const estimatedCost = this.calculateCost(costEstimationParams);

      // Enrich inputPromptJson with usage details if they exist
      const enrichedInputPromptJson = {
        ...request.inputPromptJson,
        ...(request.cachedInputTokens ? { cachedInputTokens: request.cachedInputTokens } : {}),
        ...(request.imageQuality ? { imageQuality: request.imageQuality } : {}),
        ...(request.imageSize ? { imageSize: request.imageSize } : {}),
      };

      const usageRecord: InsertTokenUsage = {
        authorId: request.authorId,
        storyId: request.storyId,
        action: request.action,
        aiModel: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        estimatedCostInEuros: estimatedCost.estimatedCostInEuros.toString(),
        inputPromptJson: enrichedInputPromptJson,
      };

      await this.db.insert(tokenUsageTracking).values(usageRecord);

      logger.info('Token usage recorded', {
        authorId: request.authorId,
        storyId: request.storyId,
        action: request.action,
        model: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        cachedInputTokens: request.cachedInputTokens,
        estimatedCostEuros: estimatedCost.estimatedCostInEuros,
        totalTokens: request.inputTokens + request.outputTokens,
      });
    } catch (error) {
      logger.error('Failed to record token usage', {
        error: error instanceof Error ? error.message : String(error),
        authorId: request.authorId,
        storyId: request.storyId,
        action: request.action,
        model: request.aiModel,
      });
      // Don't throw - we don't want to break AI operations due to tracking failures
    }
  }

  /**
   * Calculate estimated cost based on provider and model.
   *
   * Rates live in `model-pricing.ts` (ordered, dated tiers). Supported models (reviewed 2026-10-27):
   * - OpenAI Text:  gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna / gpt-6.1-luna, gpt-5.5, gpt-5.5-pro,
   *                 gpt-5.4, gpt-5.4-mini, gpt-5.4-nano
   * - OpenAI Image: gpt-image-2.5-flare / -sunburst (approximated with gpt-image-2 per-image
   *                 estimates), gpt-image-2 (quality x size table), gpt-image-1.5
   * - OpenAI TTS:   gpt-4o-mini-tts (kept for legacy callers; not advertised)
   * - Google Text:  gemini-4-argon, gemini-3.8-flash, gemini-3.6-flash, gemini-3.5-flash(-lite),
   *                 gemini-3.1-flash-lite, gemini-3.1-pro, gemini-3-pro-preview, gemini-3-flash, gemini-2.5-flash
   * - Google Image: gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-3.1-flash-image,
   *                 gemini-3-pro-image, gemini-2.5-flash-image
   * - Google TTS:   gemini-3.8-flash-tts (current); gemini-2.5-pro-tts, gemini-2.5-flash-tts
   *                 (historic records only)
   * GPT-6.x requests above 272K input tokens use the long-context surcharge (2x in, 1.5x out).
   * Unknown Google TTS models fall back to gemini-3.8-flash-tts rates, never text rates.
   * Other unknown Google models fall back to gemini-3.8-flash rates (warned once per model);
   * unknown OpenAI models cost 0 (warned once per model).
   *
   * Sources:
   * - https://ai.google.dev/gemini-api/docs/pricing
   * - https://developers.openai.com/api/docs/pricing
   */
  private calculateCost(estimation: CostEstimation): CostEstimation {
    const at = estimation.timestamp ?? new Date();
    let resolved =
      estimation.provider === 'unknown'
        ? undefined
        : resolvePricing(estimation.provider, estimation.model, at);

    if (!resolved) {
      if (estimation.provider === 'google-genai') {
        const fallbackModel = /tts/i.test(estimation.model)
          ? GOOGLE_TTS_FALLBACK_MODEL
          : GOOGLE_FALLBACK_MODEL;
        this.warnUnknownModelOnce(estimation.provider, estimation.model, fallbackModel);
        resolved = resolvePricing('google-genai', fallbackModel, at);
      } else if (estimation.provider === 'openai') {
        this.warnUnknownModelOnce(estimation.provider, estimation.model, undefined);
      }
    }

    if (!resolved) {
      estimation.estimatedCostInEuros = 0;
      return estimation;
    }

    const { entry, tier } = resolved;
    const cachedTokens = estimation.cachedInputTokens || 0;
    const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);
    // Long-context surcharge applies to the whole request once input crosses the threshold.
    const longContext =
      tier.longContext && estimation.inputTokens > tier.longContext.inputTokensAbove
        ? tier.longContext
        : undefined;
    const inputMultiplier = longContext?.inputMultiplier ?? 1;
    const outputMultiplier = longContext?.outputMultiplier ?? 1;
    const inputCostUSD =
      ((regularInputTokens * tier.inputPer1M + cachedTokens * tier.cachedInputPer1M) *
        inputMultiplier) /
      1_000_000;

    let totalCostUSD: number;
    if (entry.billing === 'image-count') {
      const tokensPerImage = tier.tokensPerImage ?? 1000;
      const rawImages = estimation.outputTokens / tokensPerImage;
      const imagesGenerated = Math.max(
        1,
        tier.imageCountRounding === 'ceil' ? Math.ceil(rawImages) : Math.floor(rawImages),
      );
      const costPerImage = this.resolvePerImageCost(tier, estimation);
      const outputCostUSD = (estimation.outputTokens * tier.outputPer1M) / 1_000_000;
      totalCostUSD = imagesGenerated * costPerImage + inputCostUSD + outputCostUSD;
    } else if (entry.billing === 'image-split') {
      const defaultResolution = tier.defaultResolution ?? '2K';
      let resolution = this.normalizeImageResolution(estimation.imageSize, defaultResolution);
      // Models with a single supported resolution (e.g. 1K-only lite-image) bill at that size.
      if (tier.perImageByResolution?.[resolution] === undefined) {
        resolution = defaultResolution;
      }
      const imageTokens = tier.tokensPerImageByResolution?.[resolution] ?? 0;
      let imageCostUSD: number;
      let textTokens: number;
      if (estimation.imageOutputTokens !== undefined) {
        // Real split available: bill image tokens at the image rate, the rest as text/thinking.
        const imageOutputTokens = Math.min(estimation.imageOutputTokens, estimation.outputTokens);
        imageCostUSD = (imageOutputTokens * (tier.imageOutputPer1M ?? 0)) / 1_000_000;
        textTokens = estimation.outputTokens - imageOutputTokens;
      } else {
        // No split: SGW requests exactly one image per call, so bill one flat image and
        // treat any output tokens beyond that image's tokens as text/thinking.
        imageCostUSD = tier.perImageByResolution?.[resolution] ?? 0;
        textTokens = Math.max(0, estimation.outputTokens - imageTokens);
      }
      totalCostUSD = imageCostUSD + inputCostUSD + (textTokens * tier.outputPer1M) / 1_000_000;
    } else {
      const outputCostUSD =
        (estimation.outputTokens * tier.outputPer1M * outputMultiplier) / 1_000_000;
      totalCostUSD = inputCostUSD + outputCostUSD;
    }

    estimation.estimatedCostInEuros = totalCostUSD * USD_TO_EUR;
    return estimation;
  }

  /**
   * Per-image price for image-count billing. Uses the quality/size table when the tier has one
   * (unknown size → square, unknown quality → medium), else the legacy perImage/perImageHd pair.
   */
  private resolvePerImageCost(tier: PricingTier, estimation: CostEstimation): number {
    if (tier.perImageByQuality) {
      const quality: ImageQualityLevel =
        estimation.imageQuality === 'hd' || estimation.imageQuality === 'high'
          ? 'high'
          : estimation.imageQuality === 'low'
            ? 'low'
            : 'medium';
      const dims = estimation.imageSize?.match(/^(\d+)\s*x\s*(\d+)$/i);
      const nonSquare = !!dims && dims[1] !== dims[2];
      return tier.perImageByQuality[nonSquare ? 'nonSquare' : 'square'][quality];
    }
    return estimation.imageQuality === 'hd' && tier.perImageHd !== undefined
      ? tier.perImageHd
      : (tier.perImage ?? 0);
  }

  private normalizeImageResolution(
    size: string | undefined,
    fallback: ImageResolution,
  ): ImageResolution {
    const normalized = size?.trim().toUpperCase();
    return normalized === '1K' || normalized === '2K' || normalized === '4K'
      ? normalized
      : fallback;
  }

  private warnUnknownModelOnce(
    provider: string,
    model: string,
    fallback: string | undefined,
  ): void {
    const key = `${provider}:${model}`;
    if (warnedUnknownModels.has(key)) return;
    warnedUnknownModels.add(key);
    logger.warn('Unknown AI model for cost estimation', {
      model,
      provider,
      fallback: fallback ?? 'none (cost 0)',
    });
  }

  /**
   * Determine provider from model name
   */
  private getProviderFromModel(model: string): 'openai' | 'google-genai' | 'unknown' {
    if (model.includes('gpt')) {
      return 'openai';
    } else if (model.includes('gemini')) {
      return 'google-genai';
    }
    return 'unknown';
  }
  /**
   * Get usage statistics for a story
   */
  async getStoryUsage(storyId: string): Promise<{
    totalTokens: number;
    totalCostEuros: number;
    actionBreakdown: Record<string, { tokens: number; cost: number; calls: number }>;
  }> {
    try {
      const usageRecords = await this.db
        .select()
        .from(tokenUsageTracking)
        .where(eq(tokenUsageTracking.storyId, storyId));

      let totalTokens = 0;
      let totalCostEuros = 0;
      const actionBreakdown: Record<string, { tokens: number; cost: number; calls: number }> = {};

      for (const record of usageRecords) {
        const tokens = record.inputTokens + record.outputTokens;
        const cost = parseFloat(record.estimatedCostInEuros);

        totalTokens += tokens;
        totalCostEuros += cost;

        if (!actionBreakdown[record.action]) {
          actionBreakdown[record.action] = { tokens: 0, cost: 0, calls: 0 };
        }

        const breakdown = actionBreakdown[record.action];
        if (breakdown) {
          breakdown.tokens += tokens;
          breakdown.cost += cost;
          breakdown.calls += 1;
        }
      }

      return {
        totalTokens,
        totalCostEuros,
        actionBreakdown,
      };
    } catch (error) {
      logger.error('Failed to get story usage statistics', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      throw error;
    }
  }
  /**
   * Get usage statistics for an author
   */
  async getAuthorUsage(
    authorId: string,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<{
    totalTokens: number;
    totalCostEuros: number;
    storyBreakdown: Record<string, { tokens: number; cost: number; calls: number }>;
    actionBreakdown: Record<string, { tokens: number; cost: number; calls: number }>;
  }> {
    try {
      const conditions = [eq(tokenUsageTracking.authorId, authorId)];

      // Add date filters if provided
      if (fromDate) {
        conditions.push(gte(tokenUsageTracking.createdAt, fromDate.toISOString()));
      }
      if (toDate) {
        conditions.push(lte(tokenUsageTracking.createdAt, toDate.toISOString()));
      }
      const usageRecords = await this.db
        .select()
        .from(tokenUsageTracking)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions));

      let totalTokens = 0;
      let totalCostEuros = 0;
      const storyBreakdown: Record<string, { tokens: number; cost: number; calls: number }> = {};
      const actionBreakdown: Record<string, { tokens: number; cost: number; calls: number }> = {};

      for (const record of usageRecords) {
        const tokens = record.inputTokens + record.outputTokens;
        const cost = parseFloat(record.estimatedCostInEuros);

        totalTokens += tokens;
        totalCostEuros += cost;

        // Story breakdown
        if (!storyBreakdown[record.storyId]) {
          storyBreakdown[record.storyId] = { tokens: 0, cost: 0, calls: 0 };
        }
        const storyData = storyBreakdown[record.storyId];
        if (storyData) {
          storyData.tokens += tokens;
          storyData.cost += cost;
          storyData.calls += 1;
        }

        // Action breakdown
        if (!actionBreakdown[record.action]) {
          actionBreakdown[record.action] = { tokens: 0, cost: 0, calls: 0 };
        }
        const actionData = actionBreakdown[record.action];
        if (actionData) {
          actionData.tokens += tokens;
          actionData.cost += cost;
          actionData.calls += 1;
        }
      }

      return {
        totalTokens,
        totalCostEuros,
        storyBreakdown,
        actionBreakdown,
      };
    } catch (error) {
      logger.error('Failed to get author usage statistics', {
        error: error instanceof Error ? error.message : String(error),
        authorId,
      });
      throw error;
    }
  }
}

export const tokenUsageTrackingService = new TokenUsageTrackingService();
