import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/db/workflows-db', () => ({
  getWorkflowsDatabase: jest.fn(),
  tokenUsageTracking: {},
}));

import { TokenUsageTrackingService } from '../services/token-usage-tracking';
import { getWorkflowsDatabase } from '@/db/workflows-db';
import { logger } from '@/config/logger';

describe('TokenUsageTrackingService', () => {
  let service: TokenUsageTrackingService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: jest.fn(),
      select: jest.fn(),
    };
    (getWorkflowsDatabase as jest.Mock).mockReturnValue(mockDb);
    service = new TokenUsageTrackingService();
    jest.clearAllMocks();
  });

  it('records usage with cost estimation', async () => {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await service.recordUsage({
      authorId: 'a1',
      storyId: 's1',
      action: 'chapter_writing',
      aiModel: 'gpt-5',
      inputTokens: 1000,
      outputTokens: 500,
      inputPromptJson: {},
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalled();
    const usageRecord = valuesMock.mock.calls[0][0];
    // GPT-5: ($0.00125 * 1 input K-tokens) + ($0.01 * 0.5 output K-tokens) = $0.00625 USD * 0.92 = €0.00575
    expect(parseFloat(usageRecord.estimatedCostInEuros)).toBeCloseTo(0.00575, 5);
    expect(logger.info).toHaveBeenCalled();
  });

  it('calculates cost for OpenAI GPT-5 model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // GPT-5: ($0.00125 * 1 input K-tokens) + ($0.01 * 0.5 output K-tokens) = $0.00625 USD * 0.92 = €0.00575
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.00575, 5);
  });

  it('aggregates story usage', async () => {
    const records = [
      { action: 'chapter_writing', inputTokens: 100, outputTokens: 50, estimatedCostInEuros: '1' },
      { action: 'image_generation', inputTokens: 0, outputTokens: 0, estimatedCostInEuros: '0.5' },
    ];

    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(records),
      }),
    });

    const result = await service.getStoryUsage('s1');
    expect(result.totalTokens).toBe(150);
    expect(result.totalCostEuros).toBeCloseTo(1.5);
    expect(result.actionBreakdown.chapter_writing.tokens).toBe(150);
    expect(result.actionBreakdown.image_generation.cost).toBeCloseTo(0.5);
  });

  it('aggregates author usage with story and action breakdown', async () => {
    const records = [
      {
        storyId: 's1',
        action: 'chapter_writing',
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostInEuros: '1',
      },
      {
        storyId: 's2',
        action: 'image_generation',
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostInEuros: '0.5',
      },
    ];

    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(records),
      }),
    });

    const result = await service.getAuthorUsage('a1');
    expect(result.totalTokens).toBe(150);
    expect(result.storyBreakdown.s1.tokens).toBe(150);
    expect(result.actionBreakdown.image_generation.cost).toBeCloseTo(0.5);
  });
});
