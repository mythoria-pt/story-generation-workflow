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
});
