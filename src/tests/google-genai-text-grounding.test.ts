import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const mockGenerate = jest.fn<any>();
const mockCount = jest.fn<any>();
const mockGetContext = jest.fn<any>();
const mockUpdate = jest.fn<any>();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(() => ({
    models: { generateContent: mockGenerate, countTokens: mockCount },
  })),
  MediaResolution: {
    MEDIA_RESOLUTION_LOW: 'LOW',
    MEDIA_RESOLUTION_MEDIUM: 'MEDIUM',
    MEDIA_RESOLUTION_HIGH: 'HIGH',
  },
}));
jest.mock('@/ai/context-manager.js', () => ({
  contextManager: { getContext: mockGetContext, updateProviderData: mockUpdate },
}));
import { GoogleGenAI } from '@google/genai';
import { GoogleGenAITextService, hydrogenUsage } from '../ai/providers/google-genai/text.js';
const response = (text: string, finishReason = 'STOP', continuationToken?: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason, continuationToken }],
  usageMetadata: {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 10,
    cachedContentTokenCount: 30,
    totalTokenCount: 130,
  },
});
describe('Hydrogen text contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue({ totalTokens: 100 });
    mockGetContext.mockResolvedValue(null);
    mockGenerate.mockResolvedValue(response('Complete prose'));
  });
  it('uses beta API and rejects other Gemini text models', () => {
    new GoogleGenAITextService({ apiKey: 'test' });
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test', apiVersion: 'v1beta' });
    expect(
      () => new GoogleGenAITextService({ apiKey: 'test', model: 'unsupported-model' }),
    ).toThrow('Only gemini-4-hydrogen');
  });
  it('passes schema, grounding and media without sampling/cache parameters', async () => {
    const service = new GoogleGenAITextService({ apiKey: 'test' });
    await service.complete('Describe', {
      temperature: 0.2,
      thinkingLevel: 'xhigh',
      googleSearchGrounding: true,
      jsonSchema: { type: 'object' },
      mediaParts: [{ mimeType: 'image/png', data: Buffer.from('image') }],
    });
    const request = mockGenerate.mock.calls[0][0];
    expect(request.model).toBe('gemini-4-hydrogen');
    expect(request.config).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
      thinkingConfig: { thinkingLevel: 'XHIGH' },
      tools: [{ googleSearch: {} }],
      automaticContinuation: false,
    });
    for (const field of ['temperature', 'topP', 'topK', 'cachedContent', 'candidateCount'])
      expect(request.config).not.toHaveProperty(field);
    expect(request.contents[0].parts[1].inlineData.data).toBe(
      Buffer.from('image').toString('base64'),
    );
  });
  it('continues thinking-only segments using the immutable request and reports every segment', async () => {
    mockGenerate
      .mockResolvedValueOnce(response('', 'CONTINUATION', 'opaque'))
      .mockResolvedValueOnce(response('Ending'));
    const observe = jest.fn();
    expect(
      await new GoogleGenAITextService({ apiKey: 'test' }).complete('Story', {
        maxTokens: 131072,
        usageObserver: observe,
      }),
    ).toBe('Ending');
    expect(mockGenerate.mock.calls[1][0].config.continuationToken).toBe('opaque');
    expect(mockGenerate.mock.calls[1][0].contents).toEqual(mockGenerate.mock.calls[0][0].contents);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ outputTokens: 30, thinkingTokens: 10, cachedInputTokens: 30 }),
    );
  });
  it('rejects truncation instead of accepting partial prose', async () => {
    mockGenerate.mockResolvedValue(response('Partial', 'MAX_TOKENS'));
    await expect(new GoogleGenAITextService({ apiKey: 'test' }).complete('Story')).rejects.toThrow(
      'incomplete',
    );
  });
  it('counts input and clamps output with headroom', async () => {
    mockCount.mockResolvedValue({ totalTokens: 1_000_000 });
    await new GoogleGenAITextService({ apiKey: 'test' }).complete('Story', { maxTokens: 131072 });
    expect(mockGenerate.mock.calls[0][0].config.maxOutputTokens).toBe(40384);
    mockCount.mockResolvedValue({ totalTokens: 1_048_576 });
    await expect(
      new GoogleGenAITextService({ apiKey: 'test' }).complete('Too much'),
    ).rejects.toThrow('capacity');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate history in a self-contained request', async () => {
    mockGetContext.mockResolvedValue({
      systemPrompt: 'Original',
      providerSpecificData: {
        googleGenAI: { history: [{ role: 'model', parts: [{ text: 'Prior' }] }] },
      },
    });
    await new GoogleGenAITextService({ apiKey: 'test' }).complete('Full history', {
      contextId: 'run',
      systemInstruction: 'Current',
    });
    expect(mockGenerate.mock.calls[0][0].contents).toHaveLength(1);
    expect(mockGenerate.mock.calls[0][0].config.systemInstruction).toBe('Current');
  });
  it('preserves safety status while protecting private errors', async () => {
    mockGenerate.mockResolvedValue({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      new GoogleGenAITextService({ apiKey: 'test' }).complete('Private', { privateContent: true }),
    ).rejects.toMatchObject({ message: 'Private text generation failed', status: 422 });
  });
  it('supports wrapped usage without double counting thinking', () => {
    expect(hydrogenUsage({ response: response('x') } as any)).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 30,
    });
  });
});
