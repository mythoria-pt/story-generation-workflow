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
    | 'test';
  aiModel: string;
  inputTokens: number;
  outputTokens: number;
  inputPromptJson: Record<string, unknown>;
}

export interface CostEstimation {
  provider: 'openai' | 'google-genai' | 'unknown';
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostInEuros: number;
}

export class TokenUsageTrackingService {
  private db = getWorkflowsDatabase();

  /**
   * Record token usage from an AI API call
   */
  async recordUsage(request: TokenUsageRequest): Promise<void> {
    try {
      const estimatedCost = this.calculateCost({
        provider: this.getProviderFromModel(request.aiModel),
        model: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        estimatedCostInEuros: 0, // Will be calculated
      });

      const usageRecord: InsertTokenUsage = {
        authorId: request.authorId,
        storyId: request.storyId,
        action: request.action,
        aiModel: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        estimatedCostInEuros: estimatedCost.estimatedCostInEuros.toString(),
        inputPromptJson: request.inputPromptJson,
      };

      await this.db.insert(tokenUsageTracking).values(usageRecord);

      logger.info('Token usage recorded', {
        authorId: request.authorId,
        storyId: request.storyId,
        action: request.action,
        model: request.aiModel,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
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
   */
  private calculateCost(estimation: CostEstimation): CostEstimation {
    let inputCostPer1KTokens = 0;
    let outputCostPer1KTokens = 0;

    // Cost calculations in USD (will convert to EUR)
    // Pricing as of October 2025
    if (estimation.provider === 'openai') {
      if (estimation.model.includes('gpt-5')) {
        // GPT-5 pricing (October 2025)
        inputCostPer1KTokens = 0.00125; // $1.25 per 1M tokens = $0.00125 per 1K tokens
        outputCostPer1KTokens = 0.01; // $10.00 per 1M tokens = $0.01 per 1K tokens
      } else if (estimation.model.includes('gpt-image-1-mini')) {
        // GPT-image-1-mini pricing is per image, not per token
        // Using medium quality as default: $0.011 per image
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        const costPerImage = 0.011; // $0.011 per image for medium quality
        estimation.estimatedCostInEuros = imagesGenerated * costPerImage * 0.92; // Convert USD to EUR (approximate)
        return estimation;
      } else if (estimation.model.includes('gpt-image-1')) {
        // GPT-image-1 pricing is per image, not per token
        // Using medium quality as default: $0.04 per image
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        const costPerImage = 0.04; // $0.04 per image for medium quality
        estimation.estimatedCostInEuros = imagesGenerated * costPerImage * 0.92; // Convert USD to EUR (approximate)
        return estimation;
      } else if (estimation.model.includes('tts-')) {
        // TTS pricing is per character, not per token
        // For TTS, inputTokens represents the number of characters in the input text
        // outputTokens can be used to represent audio duration or set to 0
        const charactersProcessed = estimation.inputTokens; // Characters in the input text
        const costPer1KCharacters = 0.015; // $0.015 per 1K characters ($15.00 per million characters)
        const totalCostUSD = (charactersProcessed / 1000) * costPer1KCharacters;
        estimation.estimatedCostInEuros = totalCostUSD * 0.92; // Convert USD to EUR (approximate)
        return estimation;
      }
    } else if (estimation.provider === 'google-genai') {
      if (estimation.model.includes('gemini')) {
        if (estimation.model.includes('gemini-2.5-pro')) {
          // Gemini 2.5 Pro pricing (October 2025)
          inputCostPer1KTokens = 0.00125; // $1.25 per 1M tokens = $0.00125 per 1K tokens
          outputCostPer1KTokens = 0.01; // $10.00 per 1M tokens = $0.01 per 1K tokens
        } else if (estimation.model.includes('gemini-2.5-flash')) {
          // Gemini 2.5 Flash pricing (October 2025)
          inputCostPer1KTokens = 0.0003; // $0.30 per 1M tokens = $0.0003 per 1K tokens
          outputCostPer1KTokens = 0.0025; // $2.50 per 1M tokens = $0.0025 per 1K tokens
        } else {
          // Default Gemini pricing (fallback for unspecified versions)
          inputCostPer1KTokens = 0.0003; // $0.30 per 1M tokens
          outputCostPer1KTokens = 0.0025; // $2.50 per 1M tokens
        }
      } else if (estimation.model.includes('imagen')) {
        // Imagen pricing is per image
        const imagesGenerated = Math.max(1, Math.floor(estimation.outputTokens / 100));
        const costPerImage = 0.006; // $0.006 per image
        estimation.estimatedCostInEuros = imagesGenerated * costPerImage * 0.92; // Convert USD to EUR (approximate)
        return estimation;
      }
    }

    // Calculate total cost in USD
    const inputCostUSD = (estimation.inputTokens / 1000) * inputCostPer1KTokens;
    const outputCostUSD = (estimation.outputTokens / 1000) * outputCostPer1KTokens;
    const totalCostUSD = inputCostUSD + outputCostUSD;

    // Convert to EUR (approximate conversion rate: 1 USD = 0.92 EUR)
    estimation.estimatedCostInEuros = totalCostUSD * 0.92;

    return estimation;
  }
  /**
   * Determine provider from model name
   */
  private getProviderFromModel(model: string): 'openai' | 'google-genai' | 'unknown' {
    if (model.includes('gpt') || model.includes('dall-e') || model.includes('tts-')) {
      return 'openai';
    } else if (model.includes('gemini') || model.includes('imagen')) {
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
