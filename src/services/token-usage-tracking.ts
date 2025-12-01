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
   * - Text Generation: gpt-5.1, gemini-2.5-flash, gemini-3-pro-preview
   * - Image Generation: gpt-5.1, gemini-2.5-flash-image, gpt-image-1, gpt-image-1-mini
   * - TTS: gemini-2.5-pro-tts, gemini-2.5-flash-tts, gpt-4o-mini-tts
   */
  private calculateCost(estimation: CostEstimation): CostEstimation {
    let inputCostPer1KTokens = 0;
    let outputCostPer1KTokens = 0;
    let cachedInputCostPer1KTokens = 0;

    // Cost calculations in USD (will convert to EUR)
    // Pricing as of December 2025

    // OpenAI Models
    if (estimation.provider === 'openai') {
      if (estimation.model.includes('gpt-5.1') || estimation.model.includes('gpt-5')) {
        // GPT-5.1 / GPT-5 - Flagship model for coding and agentic tasks
        inputCostPer1KTokens = 0.00125; // $1.25 per 1M
        outputCostPer1KTokens = 0.01; // $10.00 per 1M
        cachedInputCostPer1KTokens = 0.000125; // $0.125 per 1M
      } else if (estimation.model.includes('gpt-image-1-mini')) {
        // GPT-image-1-mini - Cost-effective image generation
        // Input tokens charged, image output is per-image pricing
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        // Approximate cost: $0.01 (low quality) per image
        let costPerImage = 0.01;
        if (estimation.imageQuality === 'hd') {
          costPerImage = 0.04; // Medium quality
        }
        // Also add input token cost: $2.00 per 1M
        const inputCostUSD = (estimation.inputTokens / 1000) * 0.002;
        estimation.estimatedCostInEuros = (imagesGenerated * costPerImage + inputCostUSD) * 0.92;
        return estimation;
      } else if (estimation.model.includes('gpt-image-1')) {
        // GPT-image-1 - High-fidelity image generation
        // Input tokens: $5.00 per 1M, Cached: $1.25 per 1M
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        // Image output: ~$0.01 (low), $0.04 (medium), $0.17 (high) for square images
        let costPerImage = 0.04; // Medium quality default
        if (estimation.imageQuality === 'hd') {
          costPerImage = 0.17; // High quality
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
        // GPT-4o-mini TTS via Realtime API
        // Input: $0.60 per 1M, Cached: $0.06 per 1M, Output: $2.40 per 1M
        inputCostPer1KTokens = 0.0006; // $0.60 per 1M
        outputCostPer1KTokens = 0.0024; // $2.40 per 1M
        cachedInputCostPer1KTokens = 0.00006; // $0.06 per 1M
      }
    }
    // Google Models
    else if (estimation.provider === 'google-genai') {
      if (estimation.model.includes('gemini-3-pro-preview')) {
        // Gemini 3 Pro Preview - Most powerful multimodal and agentic model
        inputCostPer1KTokens = 0.002; // $2.00 per 1M (prompts <= 200k)
        outputCostPer1KTokens = 0.012; // $12.00 per 1M (prompts <= 200k)
        cachedInputCostPer1KTokens = 0.0002; // $0.20 per 1M
      } else if (estimation.model.includes('gemini-2.5-pro-preview-tts') || estimation.model.includes('gemini-2.5-pro-tts')) {
        // Gemini 2.5 Pro Preview TTS - Powerful speech generation
        // Input (text): $1.00 per 1M, Output (audio): $20.00 per 1M
        inputCostPer1KTokens = 0.001; // $1.00 per 1M (text)
        outputCostPer1KTokens = 0.02; // $20.00 per 1M (audio)
        cachedInputCostPer1KTokens = 0.0001; // 10% of input
      } else if (estimation.model.includes('gemini-2.5-flash-preview-tts') || estimation.model.includes('gemini-2.5-flash-tts')) {
        // Gemini 2.5 Flash Preview TTS - Cost-effective speech generation
        // Input (text): $0.50 per 1M, Output (audio): $10.00 per 1M
        inputCostPer1KTokens = 0.0005; // $0.50 per 1M (text)
        outputCostPer1KTokens = 0.01; // $10.00 per 1M (audio)
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
