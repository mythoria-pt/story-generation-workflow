import { OpenAITextService } from '@/ai/providers/openai/text.js';
import { logger } from '@/config/logger.js';

jest.mock('@/ai/context-manager.js', () => ({ contextManager: { getContext: jest.fn() } }));

describe('private OpenAI guide calls', () => {
  const originalFetch = global.fetch;
  const originalPrompts = process.env.DEBUG_AI_FULL_PROMPTS;
  const originalResponses = process.env.DEBUG_AI_FULL_RESPONSES;
  const mockFetch = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    process.env.DEBUG_AI_FULL_PROMPTS = 'true';
    process.env.DEBUG_AI_FULL_RESPONSES = 'true';
  });
  afterAll(() => {
    global.fetch = originalFetch;
    if (originalPrompts === undefined) delete process.env.DEBUG_AI_FULL_PROMPTS;
    else process.env.DEBUG_AI_FULL_PROMPTS = originalPrompts;
    if (originalResponses === undefined) delete process.env.DEBUG_AI_FULL_RESPONSES;
    else process.env.DEBUG_AI_FULL_RESPONSES = originalResponses;
  });
  it('disables storage, passes cancellation and never logs private input/output even with debug on', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'response',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'PRIVATE OUTPUT' }] }],
      }),
    });
    const signal = new AbortController().signal;
    const service = new OpenAITextService({ apiKey: 'mock-key' });
    expect(await service.complete('PRIVATE INPUT', { privateContent: true, signal })).toBe(
      'PRIVATE OUTPUT',
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).store).toBe(false);
    expect(mockFetch.mock.calls[0][1].signal).toBe(signal);
    const logs = JSON.stringify([
      jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.debug).mock.calls,
      jest.mocked(logger.error).mock.calls,
    ]);
    expect(logs).not.toContain('PRIVATE');
  });
  it('redacts private error bodies', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'PRIVATE ERROR BODY',
    });
    await expect(
      new OpenAITextService({ apiKey: 'mock-key' }).complete('PRIVATE INPUT', {
        privateContent: true,
      }),
    ).rejects.toThrow('Private text generation failed');
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain('PRIVATE');
  });
});
