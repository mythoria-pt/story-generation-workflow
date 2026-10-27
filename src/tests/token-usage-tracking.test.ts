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
      aiModel: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 500,
      inputPromptJson: {},
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalled();
    const usageRecord = valuesMock.mock.calls[0][0];
    // GPT-5.5: ($0.005 * 1 input K-tokens) + ($0.03 * 0.5 output K-tokens) = $0.02 USD * 0.92 = €0.0184
    expect(parseFloat(usageRecord.estimatedCostInEuros)).toBeCloseTo(0.0184, 5);
    expect(logger.info).toHaveBeenCalled();
  });

  it('calculates cost for OpenAI GPT-5.5 model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // GPT-5.5: ($0.005 * 1 input K-tokens) + ($0.03 * 0.5 output K-tokens) = $0.02 USD * 0.92 = €0.0184
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.0184, 5);
  });

  it('applies cached input discount for GPT-5.5', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.5',
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // 500 regular input * $0.005/1K + 500 cached * $0.0005/1K + 500 output * $0.03/1K
    // = $0.0025 + $0.00025 + $0.015 = $0.01775 USD * 0.92 = ~€0.01633
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.01633, 5);
  });

  it('calculates cost for OpenAI gpt-5.4 model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // GPT-5.4: ($0.0025 * 1 input K-tokens) + ($0.015 * 0.5 output K-tokens) = $0.01 USD * 0.92 = €0.0092
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.0092, 5);
  });

  it('calculates cost for OpenAI gpt-5.4-mini model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // ($0.00075 * 1) + ($0.0045 * 0.5) = $0.003 USD * 0.92 = €0.00276
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.00276, 5);
  });

  it('calculates cost for OpenAI gpt-5.4-nano model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-5.4-nano',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostInEuros: 0,
    });
    // ($0.0002 * 1) + ($0.00125 * 0.5) = $0.000825 USD * 0.92 = ~€0.000759
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.000759, 6);
  });

  it('calculates cost for OpenAI gpt-image-2 model (standard quality)', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-2',
      imageQuality: 'standard',
      inputTokens: 500,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.053 + input (500/1000)*$0.005 = $0.0555 USD * 0.92 = ~€0.05106
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.05106, 4);
  });

  it('calculates cost for OpenAI gpt-image-2 model (hd quality)', () => {
    const estimation = (service as any).calculateCost({
      provider: 'openai',
      model: 'gpt-image-2',
      imageQuality: 'hd',
      inputTokens: 500,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });

    // 1 image * $0.211 + input (500/1000)*$0.005 = $0.2135 USD * 0.92 = ~€0.19642
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.19642, 4);
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

  it('calculates cost for Gemini 3.6 Flash model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3.6-flash',
      inputTokens: 2000,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });
    // Corrected 2026-10-27 to $0.75 / $3.75 per 1M (was $1.50 / $7.50).
    // Input: $0.0015; output: $0.00375; total: $0.00525 * 0.92 = €0.00483
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.00483, 5);
  });

  it('calculates cost for Gemini 3.5 Flash model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3.5-flash',
      inputTokens: 2000,
      outputTokens: 1000,
      estimatedCostInEuros: 0,
    });
    // Input: (2000/1000)*$0.0015 = $0.003
    // Output: (1000/1000)*$0.009 = $0.009
    // Total: $0.012 * 0.92 = €0.01104
    expect(estimation.estimatedCostInEuros).toBeCloseTo(0.01104, 5);
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

  it('calculates cost for Gemini 3.1 Flash Image model', () => {
    const estimation = (service as any).calculateCost({
      provider: 'google-genai',
      model: 'gemini-3.1-flash-image',
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

  describe('model pricing refresh (2026-10-27)', () => {
    const cost = (
      provider: 'openai' | 'google-genai',
      model: string,
      extra: Record<string, unknown> = {},
    ): number =>
      (service as any).calculateCost({
        provider,
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        estimatedCostInEuros: 0,
        ...extra,
      }).estimatedCostInEuros;

    // USD to EUR (0.92).
    const eur = (usd: number) => usd * 0.92;
    const NOW = new Date('2026-10-27T00:00:00Z');

    it.each([
      ['gemini-3.8-flash', 0.75 + 3.75],
      ['gemini-3.6-flash', 0.75 + 3.75],
      ['gemini-3.5-flash-lite', 0.3 + 2.5],
      ['gemini-3.5-flash', 1.5 + 9.0],
      ['gemini-3.1-flash-lite', 0.25 + 1.5],
      ['gemini-3.1-flash-lite-preview', 0.25 + 1.5],
      ['gemini-4-argon', 2.0 + 10.0],
    ])('prices Google text model %s (1M in + 1M out)', (model, usd) => {
      expect(cost('google-genai', model, { timestamp: NOW })).toBeCloseTo(eur(usd), 6);
    });

    it.each([
      ['gpt-6.1-sol', 2.0 + 10.0],
      ['gpt-6.1-terra', 1.0 + 5.0],
      ['gpt-6-luna', 0.1 + 0.5],
      ['gpt-6.1-luna', 0.1 + 0.5],
    ])('prices OpenAI text model %s (per 1M in + 1M out, below long-context)', (model, usd) => {
      // 200K in + 200K out stays under the 272K long-context threshold.
      expect(cost('openai', model, { inputTokens: 200_000, outputTokens: 200_000 })).toBeCloseTo(
        eur(usd * 0.2),
        8,
      );
    });

    it('applies cached input rates for new models', () => {
      // 200K cached input (below the GPT-6 272K long-context threshold), scaled back to per-1M.
      const cached = (provider: 'openai' | 'google-genai', model: string) =>
        cost(provider, model, {
          timestamp: NOW,
          inputTokens: 200_000,
          outputTokens: 0,
          cachedInputTokens: 200_000,
        }) * 5;
      expect(cached('google-genai', 'gemini-3.8-flash')).toBeCloseTo(eur(0.075), 6);
      expect(cached('google-genai', 'gemini-4-argon')).toBeCloseTo(eur(0.1), 6);
      expect(cached('google-genai', 'gemini-3.5-flash-lite')).toBeCloseTo(eur(0.03), 6);
      expect(cached('google-genai', 'gemini-3.1-flash-lite')).toBeCloseTo(eur(0.025), 6);
      expect(cached('openai', 'gpt-6.1-sol')).toBeCloseTo(eur(0.1), 6);
      expect(cached('openai', 'gpt-6.1-terra')).toBeCloseTo(eur(0.05), 6);
      expect(cached('openai', 'gpt-6-luna')).toBeCloseTo(eur(0.01), 6);
    });

    it('switches gemini-4-argon price on 2026-12-01', () => {
      expect(
        cost('google-genai', 'gemini-4-argon', { timestamp: new Date('2026-11-30T23:59:59Z') }),
      ).toBeCloseTo(eur(12), 6);
      expect(
        cost('google-genai', 'gemini-4-argon', { timestamp: new Date('2026-12-01T00:00:00Z') }),
      ).toBeCloseTo(eur(24), 6);
    });

    it('switches gemini-3.8-flash price on 2027-01-01', () => {
      expect(
        cost('google-genai', 'gemini-3.8-flash', { timestamp: new Date('2026-12-31T23:59:59Z') }),
      ).toBeCloseTo(eur(4.5), 6);
      expect(
        cost('google-genai', 'gemini-3.8-flash', { timestamp: new Date('2027-01-01T00:00:00Z') }),
      ).toBeCloseTo(eur(9), 6);
    });

    it('prices gpt-image-2.5 flare/sunburst like gpt-image-2', () => {
      for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
        const standard = cost('openai', model, {
          imageQuality: 'standard',
          inputTokens: 500,
          outputTokens: 1000,
        });
        const hd = cost('openai', model, {
          imageQuality: 'hd',
          inputTokens: 500,
          outputTokens: 1000,
        });
        expect(standard).toBeCloseTo(0.05106, 4);
        expect(hd).toBeCloseTo(0.19642, 4);
      }
    });

    describe('gemini-nano-banana-2.1', () => {
      const nano = (extra: Record<string, unknown>): number =>
        (service as any).calculateCost({
          provider: 'google-genai',
          model: 'gemini-nano-banana-2.1',
          estimatedCostInEuros: 0,
          ...extra,
        }).estimatedCostInEuros;

      it('bills one flat 2K image by default (no usage split)', () => {
        // 1 image * $0.0504 + 1000 input * $1.50/1M; output 1000 <= 1680 image tokens
        expect(nano({ inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(
          eur(0.0504 + 0.0015),
          6,
        );
      });

      it('bills thinking tokens beyond the image tokens at the text rate', () => {
        // 2K: 1680 image tokens; 820 extra at $7.50/1M
        expect(nano({ inputTokens: 0, outputTokens: 2500 })).toBeCloseTo(
          eur(0.0504 + (820 * 7.5) / 1_000_000),
          8,
        );
      });

      it('uses the per-resolution flat price', () => {
        expect(nano({ inputTokens: 0, outputTokens: 1120, imageSize: '1K' })).toBeCloseTo(
          eur(0.0336),
          8,
        );
        expect(nano({ inputTokens: 0, outputTokens: 3780, imageSize: '4K' })).toBeCloseTo(
          eur(0.113),
          8,
        );
      });

      it('uses the token split when imageOutputTokens is provided', () => {
        // 1680 image tokens * $30/1M + 500 text * $7.50/1M + 2000 input * $1.50/1M
        expect(
          nano({ inputTokens: 2000, outputTokens: 2180, imageOutputTokens: 1680 }),
        ).toBeCloseTo(eur((1680 * 30 + 500 * 7.5 + 2000 * 1.5) / 1_000_000), 8);
      });

      it('passes imageOutputTokens from recordUsage into the cost', async () => {
        const valuesMock = jest.fn().mockResolvedValue(undefined);
        mockDb.insert.mockReturnValue({ values: valuesMock });
        await service.recordUsage({
          authorId: 'a1',
          storyId: 's1',
          action: 'image_generation',
          aiModel: 'gemini-nano-banana-2.1',
          inputTokens: 0,
          outputTokens: 1680,
          imageOutputTokens: 1680,
          inputPromptJson: {},
        });
        expect(parseFloat(valuesMock.mock.calls[0][0].estimatedCostInEuros)).toBeCloseTo(
          eur((1680 * 30) / 1_000_000),
          6,
        );
      });
    });

    it('falls back to gemini-3.8-flash rates and warns once for unknown Google models', () => {
      const model = 'gemini-unknown-warn-once';
      const first = cost('google-genai', model, { timestamp: NOW });
      const second = cost('google-genai', model, { timestamp: NOW });
      expect(first).toBeCloseTo(eur(0.75 + 3.75), 6);
      expect(second).toBeCloseTo(first, 10);
      const warns = (logger.warn as jest.Mock).mock.calls.filter(
        (call) => (call[1] as any)?.model === model,
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]?.[1]).toMatchObject({
        model,
        provider: 'google-genai',
        fallback: 'gemini-3.8-flash',
      });
    });

    it('keeps zero cost and warns once for unknown OpenAI models', () => {
      const model = 'gpt-unknown-warn-once';
      expect(cost('openai', model)).toBe(0);
      expect(cost('openai', model)).toBe(0);
      const warns = (logger.warn as jest.Mock).mock.calls.filter(
        (call) => (call[1] as any)?.model === model,
      );
      expect(warns).toHaveLength(1);
    });

    it('prices the 1K-only lite-image variant as an image model', () => {
      // 1 image at $0.0336 + 1000 input * $0.25/1M; a 2K request still bills at 1K
      for (const imageSize of [undefined, '2K']) {
        expect(
          cost('google-genai', 'gemini-3.1-flash-lite-image', {
            inputTokens: 1000,
            outputTokens: 1120,
            ...(imageSize && { imageSize }),
          }),
        ).toBeCloseTo(eur(0.0336 + 0.00025), 8);
      }
    });

    it('switches gemini-3.6-flash price on 2027-01-01', () => {
      expect(
        cost('google-genai', 'gemini-3.6-flash', { timestamp: new Date('2026-12-31T23:59:59Z') }),
      ).toBeCloseTo(eur(4.5), 6);
      expect(
        cost('google-genai', 'gemini-3.6-flash', { timestamp: new Date('2027-01-01T00:00:00Z') }),
      ).toBeCloseTo(eur(9), 6);
    });

    it('applies the GPT-6 long-context surcharge to the whole request above 272K input', () => {
      const at = (inputTokens: number) =>
        cost('openai', 'gpt-6.1-sol', { inputTokens, outputTokens: 10_000 });
      expect(at(272_000)).toBeCloseTo(eur((272_000 * 2 + 10_000 * 10) / 1_000_000), 8);
      expect(at(272_001)).toBeCloseTo(eur((272_001 * 4 + 10_000 * 15) / 1_000_000), 8);
      expect(cost('openai', 'gpt-6-luna', { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo(
        eur((300_000 * 0.2) / 1_000_000),
        8,
      );
    });

    it.each([
      ['low', '1024x1536', 0.005],
      ['medium', '1024x1536', 0.041],
      ['high', '1536x1024', 0.165],
      ['low', '1024x1024', 0.006],
      ['high', '1024x1024', 0.211],
      ['auto', '1024x1536', 0.041],
    ])(
      'prices gpt-image-2 %s quality at %s per published table',
      (imageQuality, imageSize, usd) => {
        for (const model of ['gpt-image-2', 'gpt-image-2.5-flare']) {
          expect(
            cost('openai', model, { imageQuality, imageSize, inputTokens: 0, outputTokens: 1000 }),
          ).toBeCloseTo(eur(usd), 8);
        }
      },
    );
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
