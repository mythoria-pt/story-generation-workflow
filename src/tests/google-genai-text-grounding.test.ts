import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetContext = jest.fn();
const mockUpdateProviderData = jest.fn();
const mockGetMaxOutputTokens = jest.fn(() => 2048);
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockModelsGenerateContent = jest.fn<any>();
const mockChatsCreate = jest.fn<any>();
const mockCachesCreate = jest.fn<any>();
const mockCachesDelete = jest.fn<any>();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockModelsGenerateContent },
    chats: { create: mockChatsCreate },
    caches: { create: mockCachesCreate, delete: mockCachesDelete },
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

jest.mock('@/ai/model-limits.js', () => ({
  getMaxOutputTokens: mockGetMaxOutputTokens,
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

function buildTextResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };
}

describe('GoogleGenAITextService Gemini 3.6 requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockResolvedValue(null);
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
    expect(request.model).toBe('gemini-3.6-flash');
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

  it('uses cached context with structured multimodal generation', async () => {
    mockGetContext.mockResolvedValue({
      systemPrompt: 'System context',
      providerSpecificData: {
        googleGenAI: {
          chatInstance: { sendMessage: jest.fn() },
          cachedContentName: 'cache-1',
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
    expect(request.config.cachedContent).toBe('cache-1');
    expect(request.config.systemInstruction).toBeUndefined();
    expect(request.contents).toEqual({
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
  });

  it('keeps grounding in stateless fallback after an empty chat output', async () => {
    const mockChat = {
      sendMessage: jest.fn<any>().mockResolvedValue({
        candidates: [
          {
            content: { parts: [] },
            finishReason: 'STOP',
          },
        ],
      }),
    };
    mockGetContext.mockResolvedValue({
      systemPrompt: 'System context',
      providerSpecificData: {
        googleGenAI: { chatInstance: mockChat },
      },
    });
    mockModelsGenerateContent.mockResolvedValue(buildTextResponse('fallback'));

    const service = new GoogleGenAITextService({ apiKey: 'test-key' });

    await service.complete('What happened this week?', {
      contextId: 'ctx-fallback',
      googleSearchGrounding: true,
    });

    expect(mockChat.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: [{ text: 'What happened this week?' }],
        config: expect.objectContaining({
          systemInstruction: 'System context',
          tools: [{ googleSearch: {} }],
        }),
      }),
    );
    expect(mockModelsGenerateContent.mock.calls[0][0].config.tools).toEqual([{ googleSearch: {} }]);
  });

  it('initializes native chat/cache without a prefilled model turn', async () => {
    const chat = { sendMessage: jest.fn() };
    mockChatsCreate.mockReturnValue(chat);
    mockCachesCreate.mockResolvedValue({ name: 'cache-native' });
    mockGetContext.mockResolvedValue({
      systemPrompt: 'System context',
      providerSpecificData: {},
    });

    const service = new GoogleGenAITextService({ apiKey: 'test-key' });
    await service.initializeContext('ctx-native', 'System context', [
      'Earlier user material',
      'Earlier generated material',
    ]);

    const cacheRequest = mockCachesCreate.mock.calls[0][0];
    expect(cacheRequest.config.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Earlier user material\n\nEarlier generated material' }],
      },
    ]);
    expect(cacheRequest.config.contents.at(-1)?.role).toBe('user');
    expect(mockChatsCreate).toHaveBeenCalledWith({
      model: 'gemini-3.6-flash',
      config: {
        maxOutputTokens: 2048,
        cachedContent: 'cache-native',
      },
      history: [],
    });
    expect(mockUpdateProviderData).toHaveBeenCalledWith(
      'ctx-native',
      expect.objectContaining({
        googleGenAI: expect.objectContaining({ chatInstance: chat }),
      }),
    );
  });
});
