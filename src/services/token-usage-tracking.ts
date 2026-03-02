/**
 * Token Usage Tracking Service
 * Handles recording of AI API usage, token consumption, and cost estimation
 */

import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { tokenUsageTracking, InsertTokenUsage } from '@/db/workflows-db.js';
import { logger } from '@/config/logger.js';
import { eq, gte, lte, and } from 'drizzle-orm';

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
    | 'email_asset_generation'
    | 'test';
  aiModel: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  imageQuality?: 'standard' | 'hd';
  imageSize?: string;
  inputPromptJson: Record<string, unknown>;
}

export interface CostEstimation {
  provider: 'openai' | 'google-genai' | 'unknown';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  imageQuality?: 'standard' | 'hd';
  imageSize?: string;
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
   * Calculate estimated cost based on provider and model
   *
   * Supported Models:
   * - Text Generation: gpt-5.2, gpt-5.2-pro, gpt-5.1, gemini-3.1-pro-preview, gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-flash
   * - Image Generation: gpt-image-1.5, gpt-image-1, gpt-image-1-mini, gemini-3-pro-image-preview, gemini-3.1-flash-image-preview, gemini-2.5-flash-image
   * - TTS: gemini-2.5-pro-tts, gemini-2.5-flash-tts, gpt-4o-mini-tts
   */
  private calculateCost(estimation: CostEstimation): CostEstimation {
    let inputCostPer1KTokens = 0;
    let outputCostPer1KTokens = 0;
    let cachedInputCostPer1KTokens = 0;

    // Cost calculations in USD (converted to EUR later)
    // Pricing as of March 2026

    // OpenAI Models
    if (estimation.provider === 'openai') {
      if (estimation.model.includes('gpt-5.2-pro')) {
        // GPT-5.2 Pro (no cached discount published; treat cached as regular input)
        inputCostPer1KTokens = 0.021; // $21.00 per 1M
        outputCostPer1KTokens = 0.168; // $168.00 per 1M
        cachedInputCostPer1KTokens = 0.021;
      } else if (estimation.model.includes('gpt-5.2')) {
        // GPT-5.2 - Flagship responses model (reasoning capable)
        inputCostPer1KTokens = 0.00175; // $1.75 per 1M
        outputCostPer1KTokens = 0.014; // $14.00 per 1M
        cachedInputCostPer1KTokens = 0.000175; // $0.175 per 1M
      } else if (estimation.model.includes('gpt-5.1') || estimation.model.includes('gpt-5')) {
        // GPT-5.1 / GPT-5 - legacy pricing retained for backward compatibility
        inputCostPer1KTokens = 0.00125; // $1.25 per 1M
        outputCostPer1KTokens = 0.01; // $10.00 per 1M
        cachedInputCostPer1KTokens = 0.000125; // $0.125 per 1M
      } else if (estimation.model.includes('gpt-image-1.5')) {
        // GPT-image-1.5 - Newest image model (Responses API)
        // Per-image pricing (square 1024x1024): low $0.009, medium $0.034, high $0.133
        const imagesGenerated = Math.max(1, Math.ceil(estimation.outputTokens / 1000));
        let costPerImage = 0.034; // Medium/standard quality default
        if (estimation.imageQuality === 'hd') {
          costPerImage = 0.133; // High quality
        }
        const cachedTokens = estimation.cachedInputTokens || 0;
        const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);
        const inputCostUSD = (regularInputTokens / 1000) * 0.005; // $5.00 per 1M
        const cachedInputCostUSD = (cachedTokens / 1000) * 0.00125; // $1.25 per 1M
        const outputCostUSD = (estimation.outputTokens / 1000) * 0.01; // $10.00 per 1M (text output incl. reasoning)
        estimation.estimatedCostInEuros =
          (imagesGenerated * costPerImage + inputCostUSD + cachedInputCostUSD + outputCostUSD) *
          0.92;
        return estimation;
      } else if (estimation.model.includes('gpt-image-1-mini')) {
        // GPT-image-1-mini - Cost-effective image generation
        // Per-image pricing (square 1024x1024): low $0.005, medium $0.011, high $0.036
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        let costPerImage = 0.011; // Medium/standard quality default
        if (estimation.imageQuality === 'hd') {
          costPerImage = 0.036; // High quality
        }
        // Input tokens: $2.00 per 1M, Cached: $0.20 per 1M
        const cachedTokens = estimation.cachedInputTokens || 0;
        const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);
        const inputCostUSD = (regularInputTokens / 1000) * 0.002; // $2.00 per 1M
        const cachedInputCostUSD = (cachedTokens / 1000) * 0.0002; // $0.20 per 1M
        estimation.estimatedCostInEuros =
          (imagesGenerated * costPerImage + inputCostUSD + cachedInputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gpt-image-1')) {
        // GPT-image-1 - High-fidelity image generation
        // Per-image pricing (square 1024x1024): low $0.011, medium $0.042, high $0.167
        // Input tokens: $5.00 per 1M, Cached: $1.25 per 1M
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        let costPerImage = 0.042; // Medium quality default
        if (estimation.imageQuality === 'hd') {
          costPerImage = 0.167; // High quality
        }
        // Add input token cost
        const cachedTokens = estimation.cachedInputTokens || 0;
        const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);
        const inputCostUSD = (regularInputTokens / 1000) * 0.005;
        const cachedInputCostUSD = (cachedTokens / 1000) * 0.00125;
        estimation.estimatedCostInEuros =
          (imagesGenerated * costPerImage + inputCostUSD + cachedInputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gpt-4o-mini-tts')) {
        // GPT-4o-mini TTS - Text-to-speech model
        // Input (text): $0.60 per 1M, Output (audio): $12.00 per 1M
        inputCostPer1KTokens = 0.0006; // $0.60 per 1M
        outputCostPer1KTokens = 0.012; // $12.00 per 1M (audio tokens)
        cachedInputCostPer1KTokens = 0.00006; // $0.06 per 1M
      }
    }
    // Google Models
    else if (estimation.provider === 'google-genai') {
      if (estimation.model.includes('gemini-3.1-pro')) {
        // Gemini 3.1 Pro Preview - Latest Gemini 3 family model
        // Input: $2.00 per 1M tokens
        // Output (Text): $12.00 per 1M tokens
        // Cached input: $0.20 per 1M tokens (10% of input)
        inputCostPer1KTokens = 0.002; // $2.00 per 1M
        outputCostPer1KTokens = 0.012; // $12.00 per 1M
        cachedInputCostPer1KTokens = 0.0002; // $0.20 per 1M
      } else if (estimation.model.includes('gemini-3-pro-image')) {
        // Gemini 3 Pro Image Preview - Native image generation on Gemini 3 Pro
        // Input: $2.00 per 1M tokens (560 tokens per input image)
        // Text output: $12.00 per 1M tokens
        // Image output: $120.00 per 1M tokens
        //   1K/2K images consume 1120 tokens (~$0.134/image)
        //   4K images consume 2000 tokens (~$0.24/image)
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 1120));
        const costPerImage = 0.134; // ~$0.134 per 1K/2K image (1120 tokens * $120/1M)
        const cachedTokens = estimation.cachedInputTokens || 0;
        const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);
        const inputCostUSD = (regularInputTokens / 1000) * 0.002; // $2.00 per 1M
        const cachedInputCostUSD = (cachedTokens / 1000) * 0.0002; // $0.20 per 1M
        estimation.estimatedCostInEuros =
          (imagesGenerated * costPerImage + inputCostUSD + cachedInputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gemini-3-pro-preview')) {
        // Gemini 3 Pro Preview - DEPRECATED March 9, 2026 (migrate to gemini-3.1-pro-preview)
        // Input: $2.00 per 1M tokens
        // Output (Text): $12.00 per 1M tokens
        inputCostPer1KTokens = 0.002; // $2.00 per 1M
        outputCostPer1KTokens = 0.012; // $12.00 per 1M
        cachedInputCostPer1KTokens = 0.0002; // $0.20 per 1M
      } else if (estimation.model.includes('gemini-3.1-flash-image') || estimation.model.includes('gemini-3-flash-image')) {
        // Gemini 3.1 Flash Image Preview - Fast native image generation
        // Input: $0.25 per 1M tokens (text/image)
        // Text output: $1.50 per 1M tokens
        // Image output: $60.00 per 1M tokens
        //   1K images consume 1120 tokens (~$0.067/image)
        //   2K images consume 1680 tokens (~$0.101/image)
        //   4K images consume 2520 tokens (~$0.151/image)
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 1120));
        const costPerImage = 0.067; // ~$0.067 per 1K image (1120 tokens * $60/1M)
        const inputCostUSD = (estimation.inputTokens / 1000) * 0.00025; // $0.25 per 1M
        estimation.estimatedCostInEuros = (imagesGenerated * costPerImage + inputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gemini-3-flash')) {
        // Gemini 3 Flash Preview - Frontier intelligence built for speed
        // Input: $0.50 per 1M tokens (text/image/video), $1.00 per 1M (audio)
        // Output: $3.00 per 1M tokens
        // Cached input: $0.05 per 1M tokens (10% of input)
        inputCostPer1KTokens = 0.0005; // $0.50 per 1M
        outputCostPer1KTokens = 0.003; // $3.00 per 1M
        cachedInputCostPer1KTokens = 0.00005; // $0.05 per 1M
      } else if (
        estimation.model.includes('gemini-2.5-pro-preview-tts') ||
        estimation.model.includes('gemini-2.5-pro-tts')
      ) {
        // Gemini 2.5 Pro TTS - High-fidelity, reasoning-enhanced TTS
        // Input (Text): $1.00 per 1M tokens
        // Output (Audio): $20.00 per 1M tokens
        inputCostPer1KTokens = 0.001; // $1.00 per 1M
        outputCostPer1KTokens = 0.02; // $20.00 per 1M
        cachedInputCostPer1KTokens = 0.0001; // 10% of input
      } else if (
        estimation.model.includes('gemini-2.5-flash-preview-tts') ||
        estimation.model.includes('gemini-2.5-flash-tts')
      ) {
        // Gemini 2.5 Flash TTS - Low-latency, cost-effective multimodal TTS
        // Input (Text): $0.50 per 1M tokens
        // Output (Audio): $10.00 per 1M tokens
        inputCostPer1KTokens = 0.0005; // $0.50 per 1M
        outputCostPer1KTokens = 0.01; // $10.00 per 1M
        cachedInputCostPer1KTokens = 0.00005; // 10% of input
      } else if (estimation.model.includes('gemini-2.5-flash-image')) {
        // Gemini 2.5 Flash Image - Native image generation
        // Input: $0.30 per 1M, Output: $0.039 per image (~1290 tokens per image)
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 1290));
        const costPerImage = 0.039;
        // Add input token cost
        const inputCostUSD = (estimation.inputTokens / 1000) * 0.0003;
        estimation.estimatedCostInEuros = (imagesGenerated * costPerImage + inputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gemini-2.5-flash')) {
        // Gemini 2.5 Flash - Hybrid reasoning model with 1M context
        inputCostPer1KTokens = 0.0003; // $0.30 per 1M (text/image/video)
        outputCostPer1KTokens = 0.0025; // $2.50 per 1M
        cachedInputCostPer1KTokens = 0.00003; // $0.03 per 1M
      } else {
        // Default Gemini pricing (fallback to 2.5 Flash)
        inputCostPer1KTokens = 0.0003;
        outputCostPer1KTokens = 0.0025;
        cachedInputCostPer1KTokens = 0.00003;
      }
    }

    // Calculate total cost in USD
    const cachedTokens = estimation.cachedInputTokens || 0;
    const regularInputTokens = Math.max(0, estimation.inputTokens - cachedTokens);

    const inputCostUSD = (regularInputTokens / 1000) * inputCostPer1KTokens;
    const cachedInputCostUSD = (cachedTokens / 1000) * cachedInputCostPer1KTokens;
    const outputCostUSD = (estimation.outputTokens / 1000) * outputCostPer1KTokens;

    const totalCostUSD = inputCostUSD + cachedInputCostUSD + outputCostUSD;

    // Convert to EUR (approximate conversion rate: 1 USD = 0.92 EUR)
    estimation.estimatedCostInEuros = totalCostUSD * 0.92;

    return estimation;
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
