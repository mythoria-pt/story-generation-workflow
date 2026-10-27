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

import {
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  GoogleGenAITTSService,
  mergeWavParts,
} from '../ai/providers/google-genai/tts.js';
import { GEMINI_TTS_VOICES as REGISTRY_GEMINI_VOICES } from '../services/voice-registry.js';

function makeWav(pcm: Buffer, opts: { extraChunk?: boolean; sampleRate?: number } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 24000;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = opts.extraChunk
    ? Buffer.concat([
        Buffer.from('LIST'),
        Buffer.from([5, 0, 0, 0]),
        Buffer.from('abcde'),
        Buffer.from([0]), // pad byte
      ])
    : Buffer.alloc(0);
  const data = Buffer.concat([Buffer.from('data'), Buffer.alloc(4), pcm]);
  data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, data]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

const PCM_MIME = 'audio/L16;codec=pcm;rate=24000';

function audioResponse(audio: string | Buffer, mimeType = PCM_MIME, extra: object = {}) {
  return {
    responseId: 'response-audio',
    modelVersion: 'gemini-3.8-flash-tts',
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'unexpected non-audio preface' },
            {
              inlineData: {
                data: Buffer.from(audio).toString('base64'),
                mimeType,
              },
            },
          ],
        },
      },
    ],
    ...extra,
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

  function createService(model?: string) {
    const service = new GoogleGenAITTSService({
      apiKey: 'test-key',
      ...(model ? { model } : {}),
      defaultVoice: 'Orus',
    });
    const convert = jest
      .spyOn(service as any, 'convertToMp3')
      .mockImplementation(async (buffer: Buffer) => buffer);
    return { service, convert };
  }

  it('supports only gemini-3.8-flash-tts', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));
    const { service } = createService();

    const result = await service.synthesize('A short transcript.');

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-3.8-flash-tts');
    expect(result.model).toBe('gemini-3.8-flash-tts');
    expect(GEMINI_TTS_MODELS).toEqual(['gemini-3.8-flash-tts']);
  });

  it('rejects any other model at construction and per request, without calling the API', async () => {
    expect(() => createService('gemini-3.1-flash-tts-preview')).toThrow(
      /Unsupported Gemini TTS model/,
    );

    const { service } = createService();
    await expect(
      service.synthesize('Text.', { model: 'gemini-3.1-flash-tts' }),
    ).rejects.toMatchObject({ code: 'GEMINI_TTS_UNSUPPORTED_MODEL', retryable: false });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('uses the voice registry as the single voice list', () => {
    expect(GEMINI_TTS_VOICES).toBe(REGISTRY_GEMINI_VOICES);
  });

  it('retries an empty Gemini response inside the provider boundary', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({
        responseId: 'empty-1',
        candidates: [],
      })
      .mockResolvedValueOnce(audioResponse('recovered-audio'));

    const promise = createService().service.synthesize('A short transcript.', {
      chapterNumber: 1,
    });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.buffer.toString()).toBe('recovered-audio');
  });

  it('finds audio in any candidate part instead of assuming the first part is audio', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    const result = await createService().service.synthesize('A short transcript.');

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

    await expect(createService().service.synthesize('Blocked transcript.')).rejects.toMatchObject({
      code: 'GEMINI_TTS_BLOCKED',
      statusCode: 422,
      retryable: false,
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('sends the transcript verbatim with per-part style and a BCP-47 languageCode', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('Read this <sigh> exact transcript.', {
      voice: 'Orus',
      style: 'Warm, playful storyteller',
      languageCode: 'pt-PT',
    });

    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.8-flash-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Read this <sigh> exact transcript.',
              speechMetadata: { style: 'Warm, playful storyteller' },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: 'pt-PT',
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Orus',
            },
          },
        },
      },
    });

    // No preamble, director's notes, legacy system prompt or transcript labels in the text
    const serialized = JSON.stringify(mockGenerateContent.mock.calls[0][0].contents);
    expect(serialized).not.toMatch(/DIRECTOR|### TRANSCRIPT|single-speaker|European Portuguese/i);
  });

  it('sends one styled part per segment, in order, ignoring text/style when segments exist', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('ignored whole chunk', {
      style: 'ignored base style',
      languageCode: 'en-US',
      segments: [
        { text: 'The door creaked open.', style: 'Warm storyteller; hushed and suspenseful' },
        { text: '<gasp> A puppy!', style: 'Warm storyteller; bright and delighted' },
        { text: 'The end.' },
        { text: '   ' },
      ],
    });

    const request = mockGenerateContent.mock.calls[0][0];
    expect(request.contents).toHaveLength(1);
    expect(request.contents[0].parts).toEqual([
      {
        text: 'The door creaked open.',
        speechMetadata: { style: 'Warm storyteller; hushed and suspenseful' },
      },
      {
        text: '<gasp> A puppy!',
        speechMetadata: { style: 'Warm storyteller; bright and delighted' },
      },
      { text: 'The end.' },
    ]);
    expect(request.config.speechConfig.languageCode).toBe('en-US');
  });

  it('falls back to the whole text when segments are empty', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('Whole chunk.', { style: 'Calm', segments: [] });

    expect(mockGenerateContent.mock.calls[0][0].contents[0].parts).toEqual([
      { text: 'Whole chunk.', speechMetadata: { style: 'Calm' } },
    ]);
  });

  it('omits speechMetadata without a style and languageCode when the locale is not BCP-47', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('Plain text.', { language: 'portuguese' });

    const request = mockGenerateContent.mock.calls[0][0];
    expect(request.contents[0].parts).toEqual([{ text: 'Plain text.' }]);
    expect(request.config.speechConfig).not.toHaveProperty('languageCode');
  });

  it('decodes WAV audio through ffmpeg wav input and raw PCM through the s16le path', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from('rest-of-wav')]);
    mockGenerateContent.mockResolvedValueOnce(audioResponse(wav, 'audio/wav'));
    const wavRun = createService();
    await wavRun.service.synthesize('Text.');
    expect(wavRun.convert).toHaveBeenCalledWith(expect.any(Buffer), true);

    mockGenerateContent.mockResolvedValueOnce(audioResponse('raw-pcm', PCM_MIME));
    const pcmRun = createService();
    await pcmRun.service.synthesize('Text.');
    expect(pcmRun.convert).toHaveBeenCalledWith(expect.any(Buffer), false);

    // RIFF magic is enough even when the mime type is generic
    mockGenerateContent.mockResolvedValueOnce(audioResponse(wav, 'audio/unknown'));
    const magicRun = createService();
    await magicRun.service.synthesize('Text.');
    expect(magicRun.convert).toHaveBeenCalledWith(expect.any(Buffer), true);
  });

  it('merges multi-part WAV audio into PCM, skipping headers and extra chunks', async () => {
    const wavA = makeWav(Buffer.alloc(1000, 1));
    const wavB = makeWav(Buffer.alloc(600, 2), { extraChunk: true });

    expect(mergeWavParts([wavA, wavB]).pcm.length).toBe(1600);

    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { inlineData: { data: wavA.toString('base64'), mimeType: 'audio/wav' } },
              { inlineData: { data: wavB.toString('base64'), mimeType: 'audio/wav' } },
            ],
          },
        },
      ],
    });
    const { service, convert } = createService();
    await service.synthesize('Text.');

    const [buffer, wav, format] = convert.mock.calls[0] as unknown as [Buffer, boolean, object];
    expect(buffer.length).toBe(1600);
    expect(wav).toBe(false);
    expect(format).toEqual({ sampleRate: 24000, channels: 1 });
  });

  it('returns token usage from usageMetadata (audio output tokens preferred)', async () => {
    mockGenerateContent.mockResolvedValue(
      audioResponse('pcm-audio', PCM_MIME, {
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 260,
          candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 250 }],
        },
      }),
    );

    const result = await createService().service.synthesize('Text.');

    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 250 });
  });

  it('omits usage when the response has no usageMetadata', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    const result = await createService().service.synthesize('Text.');

    expect(result.usage).toBeUndefined();
  });

  it('strips stray pause tags from the text and from every segment before the request', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('Title. <long pause> Body <short pause> text.', {
      style: 'Calm',
    });
    expect(mockGenerateContent.mock.calls[0][0].contents[0].parts).toEqual([
      { text: 'Title. Body text.', speechMetadata: { style: 'Calm' } },
    ]);

    mockGenerateContent.mockClear();
    await createService().service.synthesize('ignored', {
      segments: [
        { text: 'One. <long pause>', style: 'Calm' },
        { text: '<short pause>' },
        { text: '<gasp> Two <long pause> three.' },
      ],
    });
    const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
    expect(parts).toEqual([
      { text: 'One.', speechMetadata: { style: 'Calm' } },
      { text: '<gasp> Two three.' },
    ]);
    expect(JSON.stringify(parts)).not.toMatch(/pause/i);
  });

  it('never sends a legacy systemPrompt to Gemini', async () => {
    mockGenerateContent.mockResolvedValue(audioResponse('pcm-audio'));

    await createService().service.synthesize('Plain text.', {
      systemPrompt: 'Use European Portuguese.',
    });

    expect(JSON.stringify(mockGenerateContent.mock.calls[0][0])).not.toContain(
      'European Portuguese',
    );
  });

  it('allows about five minutes of narration (4500 characters) per Gemini request', () => {
    expect(createService().service.getMaxTextLength()).toBe(4500);
  });
});
