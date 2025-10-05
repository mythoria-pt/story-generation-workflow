import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: jest.fn(),
}));

import { AIServiceHelper } from '../services/ai-service-helper';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { logger } from '@/config/logger';

describe('AIServiceHelper', () => {
  let helper: AIServiceHelper;
  let mockTextService: any;
  let mockImageService: any;
  let mockGateway: any;

  beforeEach(() => {
    mockTextService = { complete: jest.fn() };
    mockImageService = { generate: jest.fn() };
    mockGateway = {
      getTextService: jest.fn().mockReturnValue(mockTextService),
      getImageService: jest.fn().mockReturnValue(mockImageService),
    };
    (getAIGatewayWithTokenTracking as jest.Mock).mockReturnValue(mockGateway);
    helper = new AIServiceHelper();
    jest.clearAllMocks();
  });

  it('delegates text generation to gateway service', async () => {
    mockTextService.complete.mockResolvedValue('result');
    const context = { authorId: 'a', storyId: 's', action: 'test' } as any;

    const result = await helper.generateText('prompt', context);

    expect(result).toBe('result');
    expect(mockGateway.getTextService).toHaveBeenCalledWith(context);
    expect(mockTextService.complete).toHaveBeenCalledWith('prompt', undefined);
  });

  it('logs and rethrows text generation errors', async () => {
    const error = new Error('fail');
    mockTextService.complete.mockRejectedValue(error);
    const context = { authorId: 'a', storyId: 's', action: 'test' } as any;

    await expect(helper.generateText('prompt', context)).rejects.toThrow(error);
    expect(logger.error).toHaveBeenCalledWith(
      'Text generation failed in AI service helper',
      expect.objectContaining({ context }),
    );
  });

  it('delegates image generation to gateway service', async () => {
    mockImageService.generate.mockResolvedValue(Buffer.from('img'));
    const context = { authorId: 'a', storyId: 's', action: 'test' } as any;

    const result = await helper.generateImage('prompt', context);

    expect(result).toBeInstanceOf(Buffer);
    expect(mockGateway.getImageService).toHaveBeenCalledWith(context);
    expect(mockImageService.generate).toHaveBeenCalledWith('prompt', undefined);
  });

  it('logs and rethrows image generation errors', async () => {
    const error = new Error('img fail');
    mockImageService.generate.mockRejectedValue(error);
    const context = { authorId: 'a', storyId: 's', action: 'test' } as any;

    await expect(helper.generateImage('prompt', context)).rejects.toThrow(error);
    expect(logger.error).toHaveBeenCalledWith(
      'Image generation failed in AI service helper',
      expect.objectContaining({ context }),
    );
  });

  it('creates context objects', () => {
    const ctx = helper.createContext('auth', 'story', 'test' as any);
    expect(ctx).toEqual({ authorId: 'auth', storyId: 'story', action: 'test' });
  });
});
