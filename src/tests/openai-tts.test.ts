import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCreate = jest.fn<any>();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    audio: { speech: { create: mockCreate } },
  })),
}));

jest.mock('@/config/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { OpenAITTSService } from '../ai/providers/openai/tts.js';

describe('OpenAITTSService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) });
  });

  it('sends instructions via the instructions parameter, not in the spoken input', async () => {
    const service = new OpenAITTSService({ apiKey: 'k' });

    await service.synthesize('Once upon a time.', { systemPrompt: 'Speak warmly.' });

    const request = mockCreate.mock.calls[0][0];
    expect(request.input).toBe('Once upon a time.');
    expect(request.instructions).toBe('Speak warmly.');
  });

  it('strips Gemini pause tags from the input and skips instructions for tts-1', async () => {
    const service = new OpenAITTSService({ apiKey: 'k', model: 'tts-1' });

    await service.synthesize('Title. <long pause> Body <short pause> text.', {
      systemPrompt: 'Speak warmly.',
    });

    const request = mockCreate.mock.calls[0][0];
    expect(request.input).toBe('Title. Body text.');
    expect(request).not.toHaveProperty('instructions');
  });
});
