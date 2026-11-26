import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

const mockGetContext = jest.fn();
const mockUpdateProviderData = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockModelsGenerateContent = jest.fn<any>();
const mockCountTokens = jest.fn<any>();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockModelsGenerateContent, countTokens: mockCountTokens },
  })),
  MediaResolution: {
    MEDIA_RESOLUTION_LOW: 'MEDIA_RESOLUTION_LOW',
    MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM',
    MEDIA_RESOLUTION_HIGH: 'MEDIA_RESOLUTION_HIGH',
  },
  ThinkingLevel: {
    MINIMAL: 'MINIMAL',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
  },
}));

jest.mock('@/config/logger.js', () => ({
  logger: mockLogger,
}));

jest.mock('../ai/context-manager.js', () => ({
  contextManager: {
    getContext: mockGetContext,
    updateProviderData: mockUpdateProviderData,
  },
}));

import { GoogleGenAITextService } from '../ai/providers/google-genai/text.js';
import { generatePremiumText } from '../services/premium-book-ai.js';
import { TokenUsageTrackingService } from '../services/token-usage-tracking.js';

function buildTextResponse(text: string) {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
  };
}

describe('GoogleGenAITextService Hydrogen requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockResolvedValue(null);
    mockCountTokens.mockResolvedValue({ totalTokens: 17 });
    mockModelsGenerateContent.mockResolvedValue(buildTextResponse('stateless'));
  });

  it('uses native structured output and omits deprecated sampling parameters', async () => {
    const service = new GoogleGenAITextService({ apiKey: 'test-key' });

    await service.complete('Tell me something current', {
      jsonSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      },
      googleSearchGrounding: true,
      temperature: 0.2,
    });

    const request = mockModelsGenerateContent.mock.calls[0][0];
    expect(request.model).toBe('gemini-4-hydrogen');
    expect(request.config.tools).toEqual([{ googleSearch: {} }]);
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseJsonSchema).toEqual({
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
    });
    expect(request.config).not.toHaveProperty('temperature');
    expect(request.config).not.toHaveProperty('topP');
    expect(request.config).not.toHaveProperty('topK');
    expect(request.config).not.toHaveProperty('candidateCount');
  });

  it('leaves tools unset for non-grounded stateless generation', async () => {
    const service = new GoogleGenAITextService({ apiKey: 'test-key' });

    await service.complete('Plain request without grounding');

    const request = mockModelsGenerateContent.mock.calls[0][0];
    expect(request.config.tools).toBeUndefined();
  });

  it('uses the explicitly configured Neon model for token counting, output and usage', async () => {
    expect(
      () => new GoogleGenAITextService({ apiKey: 'test-key', model: 'gemini-4-neon' }),
    ).toThrow('Unsupported Gemini text generation model');
    const service = new GoogleGenAITextService({
      apiKey: 'test-key',
      model: 'gemini-4-neon',
      premiumBook: true,
    });
    const usageObserver = jest.fn();
    mockModelsGenerateContent.mockResolvedValue({
      ...buildTextResponse('{"answer":"yes"}'),
      usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
    });
    await service.complete('Read the title', {
      model: 'gemini-4-neon',
      jsonSchema: { type: 'object' },
      thinkingLevel: 'low',
      usageObserver,
    });
    expect(mockCountTokens.mock.calls[0][0]).toMatchObject({ model: 'gemini-4-neon' });
    expect(mockModelsGenerateContent.mock.calls[0][0]).toMatchObject({
      model: 'gemini-4-neon',
      config: { thinkingConfig: { thinkingLevel: 'LOW' }, responseMimeType: 'application/json' },
    });
    expect(usageObserver).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-4-neon', inputTokens: 17, outputTokens: 5 }),
    );
  });

  it.each([
    ['shot-plan-spread-1', [], 45_000],
    ['spread-1', [Buffer.from('image')], 75_000],
    ['storyboard', [], 200_000],
  ] as const)(
    'applies the whole-call deadline to token counting and generation for %s',
    async (phase, images, timeoutMs) => {
      const signal = new AbortController().signal;
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
      mockModelsGenerateContent.mockResolvedValueOnce(buildTextResponse('{"answer":"ok"}'));
      try {
        await expect(
          generatePremiumText(
            { storyId: 'story', ownerId: 'owner', revision: 'revision' },
            { provider: 'google-genai', model: 'gemini-4-hydrogen' },
            phase,
            'Prompt',
            z.object({ answer: z.string() }),
            [...images],
          ),
        ).resolves.toEqual({ answer: 'ok' });
        expect(timeout).toHaveBeenCalledWith(timeoutMs);
        expect(mockCountTokens).toHaveBeenCalledTimes(1);
        expect(mockModelsGenerateContent).toHaveBeenCalledTimes(1);
        expect(mockCountTokens.mock.calls[0][0].config).toMatchObject({
          abortSignal: signal,
          httpOptions: { retryOptions: { attempts: 1 } },
        });
        expect(mockModelsGenerateContent.mock.calls[0][0].config).toMatchObject({
          abortSignal: signal,
          httpOptions: { retryOptions: { attempts: 1 } },
        });
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it('records measured thinking usage and exposes a fixed error for an incomplete premium shot plan', async () => {
    mockModelsGenerateContent.mockResolvedValueOnce({
      candidates: [
        { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'private unfinished scene' }] } },
      ],
      usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 0, thoughtsTokenCount: 4096 },
    });
    const recordUsage = jest
      .spyOn(TokenUsageTrackingService.prototype, 'recordUsage')
      .mockResolvedValue(undefined);
    try {
      await expect(
        generatePremiumText(
          { storyId: 'story', ownerId: 'owner', revision: 'revision' },
          { provider: 'google-genai', model: 'gemini-4-hydrogen' },
          'shot-plan-spread-2',
          'Private story prompt',
          z.object({ scene: z.string().max(1200) }),
        ),
      ).rejects.toMatchObject({ status: 502, code: 'premium_shot_plan_incomplete' });
      expect(mockModelsGenerateContent.mock.calls[0][0].config).toMatchObject({
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: 'LOW' },
        responseJsonSchema: { properties: { scene: { maxLength: 1200 } } },
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Google text generation failed',
        expect.objectContaining({ code: 'INCOMPLETE_OUTPUT', finishReason: 'MAX_TOKENS' }),
      );
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'prompt_rewrite',
          inputTokens: 123,
          outputTokens: 4096,
          inputPromptJson: { mode: 'premium', revision: 'revision', phase: 'shot-plan-spread-2' },
        }),
      );
    } finally {
      recordUsage.mockRestore();
    }
  });

  it.each([
    ['low', 'LOW'],
    ['high', 'HIGH'],
  ] as const)('sends %s thinking with Gemini 4 Hydrogen', async (level, expected) => {
    const service = new GoogleGenAITextService({ apiKey: 'test-key' });
    await service.complete('Test prompt', { model: 'gemini-4-hydrogen', thinkingLevel: level });
    expect(mockModelsGenerateContent.mock.calls[0][0]).toMatchObject({
      model: 'gemini-4-hydrogen',
      config: { thinkingConfig: { thinkingLevel: expected } },
    });
  });

  it('uses saved context with structured multimodal generation', async () => {
    mockGetContext.mockResolvedValue({
      systemPrompt: 'System context',
      providerSpecificData: {
        googleGenAI: {
          history: [{ role: 'user', parts: [{ text: 'Earlier chapter' }] }],
        },
      },
    });

    const service = new GoogleGenAITextService({ apiKey: 'test-key' });

    await service.complete('Describe and cite this image', {
      contextId: 'ctx-1',
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
      },
      mediaParts: [{ mimeType: 'image/png', data: Buffer.from('image-bytes') }],
      googleSearchGrounding: true,
    });

    const request = mockModelsGenerateContent.mock.calls[0][0];
    expect(request.config.tools).toEqual([{ googleSearch: {} }]);
    expect(request.config.systemInstruction).toBe('System context');
    expect(request.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'Earlier chapter' }],
    });
    expect(request.contents[1]).toEqual({
      role: 'user',
      parts: expect.arrayContaining([
        { text: 'Describe and cite this image' },
        {
          inlineData: {
            data: Buffer.from('image-bytes').toString('base64'),
            mimeType: 'image/png',
          },
        },
      ]),
    });
    expect(mockCountTokens.mock.calls[0][0].contents[0].parts[0].text).toContain('System context');
  });

  it('retains grounding across continuation segments and omits private thoughts', async () => {
    mockModelsGenerateContent
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ text: 'private thought', thought: true }, { text: 'First' }] },
            finishReason: 'CONTINUATION',
            continuationToken: 'resume-token',
          },
        ],
      })
      .mockResolvedValueOnce(buildTextResponse(' part'));
    const service = new GoogleGenAITextService({ apiKey: 'test-key' });
    const usageObserver = jest.fn();
    await expect(
      service.complete('What happened this week?', { googleSearchGrounding: true, usageObserver }),
    ).resolves.toBe('First part');
    expect(mockModelsGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockModelsGenerateContent.mock.calls[1][0].config).toMatchObject({
      continuationToken: 'resume-token',
      tools: [{ googleSearch: {} }],
    });
    expect(usageObserver).toHaveBeenCalledTimes(2);
  });

  it('initializes local context without a prefilled model turn', async () => {
    const service = new GoogleGenAITextService({ apiKey: 'test-key' });
    await service.initializeContext('ctx-native', 'System context', [
      'Earlier user material',
      'Earlier generated material',
    ]);

    expect(mockUpdateProviderData).toHaveBeenCalledWith('ctx-native', {
      googleGenAI: {
        history: [
          {
            role: 'user',
            parts: [{ text: 'Earlier user material\n\nEarlier generated material' }],
          },
        ],
      },
    });
  });
  it('forwards cancellation and omits private provider errors and prompt previews', async () => {
    const service = new GoogleGenAITextService({ apiKey: 'test-key', model: 'gemini-4-hydrogen' });
    const signal = new AbortController().signal;
    mockModelsGenerateContent.mockRejectedValue(new Error('PRIVATE PROVIDER CONTENT'));
    await expect(
      service.complete('PRIVATE USER CONTENT', { privateContent: true, signal }),
    ).rejects.toThrow('Private text generation failed');
    expect(mockCountTokens.mock.calls[0][0].config.abortSignal).toBe(signal);
    expect(mockModelsGenerateContent.mock.calls[0][0].config.abortSignal).toBe(signal);
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('PRIVATE');
  });
});
