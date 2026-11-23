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
  it('sends a closed schema for story outlines and preserves optional fields as nullable', async () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' }, note: { type: 'string' } },
      required: ['title'],
    };
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: '{"title":"Garden","note":null}' }],
            },
          ],
        }),
      ),
    );
    await new OpenAITextService({ apiKey: 'mock-key', model: 'gpt-5.6-terra' }).complete('Garden', {
      jsonSchema: schema,
      temperature: 0.8,
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.format.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'note'],
      properties: {
        title: { type: 'string' },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('temperature');
    expect(schema.required).toEqual(['title']);
  });
  it('keeps structured diagnostics for a private rejection', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_json_schema',
            param: 'text.format.schema',
            message: 'PRIVATE ERROR BODY',
          },
        }),
        { status: 400, headers: { 'x-request-id': 'req_debug' } },
      ),
    );
    await expect(
      new OpenAITextService({ apiKey: 'mock-key' }).complete('PRIVATE INPUT', {
        privateContent: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_json_schema', status: 400 });
    const logs = JSON.stringify(jest.mocked(logger.error).mock.calls);
    expect(logs).toContain('text.format.schema');
    expect(logs).toContain('req_debug');
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
