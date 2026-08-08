import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGenerateContent = jest.fn<any>();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
  FinishReason: {
    SAFETY: 'SAFETY',
    RECITATION: 'RECITATION',
    LANGUAGE: 'LANGUAGE',
    BLOCKLIST: 'BLOCKLIST',
    PROHIBITED_CONTENT: 'PROHIBITED_CONTENT',
    SPII: 'SPII',
    MAX_TOKENS: 'MAX_TOKENS',
  },
}));

jest.mock('fluent-ffmpeg', () => {
  const ffmpegMock = jest.fn();
  (ffmpegMock as any).setFfmpegPath = jest.fn();
  return ffmpegMock;
});

jest.mock('@/config/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { GoogleGenAITTSService } from '../ai/providers/google-genai/tts.js';

function audioResponse(audio: string) {
  return {
    responseId: 'response-audio',
    modelVersion: 'gemini-3.1-flash-tts-preview',
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'unexpected non-audio preface' },
            {
              inlineData: {
                data: Buffer.from(audio).toString('base64'),
                mimeType: 'audio/L16;codec=pcm;rate=24000',
              },
            },
          ],
        },
      },
    ],
  };
}

describe('GoogleGenAITTSService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService() {
    const service = new GoogleGenAITTSService({
      apiKey: 'test-key',
      model: 'gemini-3.1-flash-tts-preview',
      defaultVoice: 'Orus',
    });
    jest
      .spyOn(service as any, 'convertPcmToMp3')
      .mockImplementation(async (buffer: Buffer) => buffer);
    return service;
  }

  it('retries an empty Gemini response inside the provider boundary', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({
        responseId: 'empty-1',
        candidates: [],
      })
      .mockResolvedValueOnce(audioResponse('recovered-audio'));

    const promise = createService().synthesize('A short transcript.', { chapterNumber: 1 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.buffer.toString()).toBe('recovered-audio');
  });

  it('finds audio in any candidate part instead of assuming the first part is audio', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    const result = await createService().synthesize('A short transcript.');

    expect(result.buffer.toString()).toBe('pcm-audio');
  });

  it('does not retry a Gemini content block', async () => {
    mockGenerateContent.mockResolvedValue({
      responseId: 'blocked-1',
      candidates: [],
      promptFeedback: {
        blockReason: 'PROHIBITED_CONTENT',
        blockReasonMessage: 'Prompt rejected',
      },
    });

    await expect(createService().synthesize('Blocked transcript.')).rejects.toMatchObject({
      code: 'GEMINI_TTS_BLOCKED',
      statusCode: 422,
      retryable: false,
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('uses a clear speech-only preamble and the documented audio request shape', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().synthesize('Read this exact transcript.', {
      voice: 'Orus',
      systemPrompt: 'Use European Portuguese.',
    });

    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-tts-preview',
      contents: expect.stringContaining(
        'Generate single-speaker speech from the transcript below.',
      ),
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Orus',
            },
          },
        },
      },
    });
    const request = mockGenerateContent.mock.calls[0][0];
    expect(request.contents).toContain('Return audio only; do not return text.');
    expect(request.contents).toContain('### TRANSCRIPT\nRead this exact transcript.');
  });

  it('limits each Gemini request to a few minutes of narration', () => {
    expect(createService().getMaxTextLength()).toBe(2500);
  });
});
