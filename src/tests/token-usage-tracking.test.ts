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
      aiModel: 'gpt-5.2',
      inputTokens: 1000,
      outputTokens: 500,
      inputPromptJson: {},
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalled();
    const usageRecord = valuesMock.mock.calls[0][0];
    // GPT-5.2: ($0.00175 * 1 input K-tokens) + ($0.014 * 0.5 output K-tokens) = $0.00875 USD * 0.92 ≈ €0.00805
    expect(parseFloat(usageRecord.estimatedCostInEuros)).toBeCloseTo(0.00805, 5);
    expect(logger.info).toHaveBeenCalled();
  });

  it('calculates cost for OpenAI GPT-5.2 model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.2',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // GPT-5.2: ($0.00175 * 1 input K-tokens) + ($0.014 * 0.5 output K-tokens) = $0.00875 USD * 0.92 ≈ €0.00805
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.00805, 5);
  });

  it('calculates cost for OpenAI gpt-image-1.5 model (standard quality)', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-1.5',
      imageQuality: 'standard',
      inputTokens: 500,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.034 + input (500/1000)*$0.005 + output (1000/1000)*$0.01 = $0.0465 USD * 0.92 = ~0.04278
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.04278, 4);
  });

  it('calculates cost for OpenAI gpt-image-1.5 model (hd quality)', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-1.5',
      imageQuality: 'hd',
      inputTokens: 500,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.133 + input (500/1000)*$0.005 + output (1000/1000)*$0.01 = $0.1455 USD * 0.92 = ~0.13386
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.13386, 4);
  });

  it('calculates cost for OpenAI gpt-image-1 model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-1',
      imageQuality: 'standard',
      inputTokens: 1000,
      outputTokens: 100,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.042 + input (1000/1000)*$0.005 = $0.047 USD * 0.92 = ~0.04324
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.04324, 4);
  });

  it('calculates cost for OpenAI gpt-image-1-mini model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-1-mini',
      imageQuality: 'standard',
      inputTokens: 500,
      outputTokens: 100,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.011 + input (500/1000)*$0.002 = $0.012 USD * 0.92 = ~0.01104
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.01104, 4);
  });

  it('calculates cost for OpenAI gpt-4o-mini-tts model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      inputTokens: 1000,
      outputTokens: 10000,
      estimatedCostInEuros: 0,
    });

    // Input: (1000/1000)*$0.0006 = $0.0006
    // Output: (10000/1000)*$0.012 = $0.12
    // Total: $0.1206 * 0.92 = ~0.110952
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.110952, 4);
  });

  it('calculates cost for Gemini 3.1 Pro Preview model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3.1-pro-preview',
      inputTokens: 2000,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });

    // Input: (2000/1000)*$0.002 = $0.004
    // Output: (1000/1000)*$0.012 = $0.012
    // Total: $0.016 * 0.92 = ~0.01472
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.01472, 5);
  });

  it('calculates cost for Gemini 3 Pro Image Preview model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3-pro-image-preview',
      inputTokens: 1000,
      outputTokens: 1120,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.134 + input (1000/1000)*$0.002 = $0.136 USD * 0.92 = ~0.12512
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.12512, 4);
  });

  it('calculates cost for Gemini 3.1 Flash Image Preview model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3.1-flash-image-preview',
      inputTokens: 1000,
      outputTokens: 1120,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.067 + input (1000/1000)*$0.00025 = $0.06725 USD * 0.92 = ~0.06187
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.06187, 4);
  });

  it('calculates cost for Gemini 3 Flash Preview model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3-flash-preview',
      inputTokens: 5000,
      outputTokens: 2000,
      estimatedCostInEuros: 0,
    });

    // Input: (5000/1000)*$0.0005 = $0.0025
    // Output: (2000/1000)*$0.003 = $0.006
    // Total: $0.0085 * 0.92 = ~0.00782
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.00782, 5);
  });

  it('calculates cost for Gemini 2.5 Flash TTS model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-2.5-flash-preview-tts',
      inputTokens: 1000,
      outputTokens: 5000,
      estimatedCostInEuros: 0,
    });

    // Input: (1000/1000)*$0.0005 = $0.0005
    // Output: (5000/1000)*$0.01 = $0.05
    // Total: $0.0505 * 0.92 = ~0.04646
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.04646, 5);
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
