import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockRecordUsage = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('@/services/token-usage-tracking.js', () => ({
  tokenUsageTrackingService: {
    recordUsage: mockRecordUsage,
  },
}));

jest.mock('@/config/logger.js', () => ({
  logger: mockLogger,
}));

import { TextGenerationMiddleware } from '../ai/token-tracking-middleware.js';

describe('TextGenerationMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves googleSearchGrounding in sanitized logged options', async () => {
    const baseService = {
      complete: jest.fn().mockResolvedValue('grounded output'),
    };

    const middleware = new TextGenerationMiddleware(baseService, {
      authorId: 'author-1',
      storyId: 'story-1',
      action: 'test',
    });

    await middleware.complete('Need current facts', {
      model: 'gemini-2.5-flash',
      googleSearchGrounding: true,
      mediaParts: [{ mimeType: 'image/png', data: Buffer.from('abc123') }],
    });

    await new Promise<void>((resolve) => {
      globalThis.setImmediate(resolve);
    });

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const usagePayload = mockRecordUsage.mock.calls[0][0];
    expect(usagePayload.inputPromptJson.options.googleSearchGrounding).toBe(true);
    expect(usagePayload.inputPromptJson.options.mediaParts).toEqual([
      { mimeType: 'image/png', sizeBytes: Buffer.from('abc123').length },
    ]);
    expect(usagePayload.inputPromptJson.options.usageObserver).toBeUndefined();
  });
  it('retains cost accounting without private prompt or system content', async () => {
    const middleware = new TextGenerationMiddleware(
      { complete: jest.fn().mockResolvedValue('private output') },
      { authorId: 'author', storyId: 'guide:session', action: 'story_enhancement' },
    );
    await middleware.complete('PRIVATE FAMILY MEMORY', {
      privateContent: true,
      systemInstruction: 'PRIVATE SYSTEM',
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(mockRecordUsage.mock.calls);
    expect(serialized).not.toContain('PRIVATE FAMILY MEMORY');
    expect(serialized).not.toContain('PRIVATE SYSTEM');
    expect(serialized).not.toContain('private output');
    expect(mockRecordUsage.mock.calls[0][0].inputPromptJson.operation).toBe('story_guide');
  });
  it('sums measured segments, forwards cached discounts and retains usage on failure', async () => {
    const base = {
      complete: jest.fn(async (_prompt: string, options: any) => {
        options.usageObserver({
          model: 'gemini-4-hydrogen',
          inputTokens: 100,
          outputTokens: 30,
          cachedInputTokens: 20,
          thinkingTokens: 10,
        });
        options.usageObserver({
          model: 'gemini-4-hydrogen',
          inputTokens: 150,
          outputTokens: 40,
          cachedInputTokens: 80,
          thinkingTokens: 15,
        });
        throw new Error('Final segment failed');
      }),
    };
    const middleware = new TextGenerationMiddleware(base, {
      authorId: 'author',
      storyId: 'story',
      action: 'chapter_writing',
    });
    await expect(middleware.complete('Story')).rejects.toThrow('Final segment failed');
    await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        aiModel: 'gemini-4-hydrogen',
        inputTokens: 250,
        outputTokens: 70,
        cachedInputTokens: 100,
        inputPromptJson: expect.objectContaining({ status: 'failed', thinkingTokens: 25 }),
      }),
    );
  });
});
