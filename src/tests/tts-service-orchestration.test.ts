import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSynthesize = jest.fn<any>();
const mockGetMaxTextLength = jest.fn<any>(() => 100000);
const mockGetStory = jest.fn<any>();
const mockRecordUsage = jest.fn<any>();
const mockGetBaseStyle = jest.fn<any>();
const mockDirectNarration = jest.fn<any>();
const mockShouldDirect = jest.fn<any>();
const mockGetTTSSystemPrompt = jest.fn<any>();

jest.mock('@/config/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/config/environment.js', () => ({
  getEnvironment: () => ({ BACKGROUND_MUSIC_ENABLED: false }),
}));

jest.mock('@/ai/tts-gateway.js', () => ({
  getTTSGateway: () => ({
    getTTSService: () => ({
      synthesize: mockSynthesize,
      getMaxTextLength: mockGetMaxTextLength,
      getProvider: () => 'google-genai',
    }),
    getService: () => {
      throw new Error('provider switch not expected');
    },
  }),
}));

jest.mock('../services/story.js', () => ({
  StoryService: jest.fn().mockImplementation(() => ({ getStory: mockGetStory })),
}));

jest.mock('../services/storage.js', () => ({ StorageService: jest.fn() }));
jest.mock('../services/storage-singleton.js', () => ({
  getStorageService: () => ({ uploadFile: jest.fn<any>().mockResolvedValue('gs://audio/1.mp3') }),
}));

jest.mock('../services/chapters.js', () => ({
  ChaptersService: jest.fn().mockImplementation(() => ({
    updateChapterAudio: jest.fn<any>().mockResolvedValue(undefined),
  })),
}));

jest.mock('../services/token-usage-tracking.js', () => ({
  tokenUsageTrackingService: { recordUsage: mockRecordUsage },
}));

jest.mock('../services/audio-prompt.js', () => ({
  AudioPromptService: {
    getBaseStyle: mockGetBaseStyle,
    getTTSSystemPrompt: mockGetTTSSystemPrompt,
  },
}));

jest.mock('../services/audio-concatenation.js', () => ({
  concatenateAudioBuffers: jest.fn<any>(async (buffers: Buffer[]) => ({
    buffer: Buffer.concat(buffers),
    chunkCount: buffers.length,
    totalSize: 0,
  })),
  mixAudioWithBackground: jest.fn(),
  measureAudioDurationSeconds: jest.fn<any>().mockResolvedValue(42),
}));

jest.mock('../services/background-music.js', () => ({ getBackgroundMusicForStory: jest.fn() }));

jest.mock('../services/tts-utils.js', () => ({
  ...(jest.requireActual('../services/tts-utils.js') as object),
  buildFirstChapterAudioText: jest.fn<any>(
    async (_t: string, _d: string, _a: string, _l: string, content: string) => content,
  ),
  buildChapterAudioText: jest.fn<any>(async (_n: number, _l: string, content: string) => content),
}));

jest.mock('../services/narration-direction.js', () => ({
  ...(jest.requireActual('../services/narration-direction.js') as object),
  shouldDirectNarration: mockShouldDirect,
  directNarration: mockDirectNarration,
}));

import { TTSService, isVoiceError } from '../services/tts.js';

const BASE_STYLE = 'Warm storyteller';

function ttsResult(extra: object = {}) {
  return {
    buffer: Buffer.from('mp3'),
    format: 'mp3',
    voice: 'Puck',
    model: 'gemini-3.8-flash-tts',
    provider: 'google-genai',
    ...extra,
  };
}

const PARAGRAPH = `${'word '.repeat(110).trim()}.`;
const LONG_CONTENT = [PARAGRAPH, PARAGRAPH, PARAGRAPH, PARAGRAPH].join('\n\n');

describe('TTSService.generateChapterAudioFromText orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TTS_PROVIDER = 'google-genai';
    process.env.TTS_VOICE = 'Charon';
    mockGetMaxTextLength.mockReturnValue(100000);
    mockShouldDirect.mockReturnValue(false);
    mockGetBaseStyle.mockResolvedValue(BASE_STYLE);
    mockGetTTSSystemPrompt.mockResolvedValue('system prompt');
    mockSynthesize.mockReset();
    mockSynthesize.mockResolvedValue(ttsResult());
    mockGetStory.mockResolvedValue({
      targetAudience: 'children_3-6',
      storyLanguage: 'pt-PT',
      authorId: 'author-1',
      author: 'Author',
    });
  });

  const run = (voice?: string) =>
    new TTSService().generateChapterAudioFromText(
      'story-1',
      2,
      'Once upon a time.',
      'Title',
      voice,
    );

  it.each([undefined, '', 'auto', ' AUTO '])('uses the audience voice for %p', async (voice) => {
    await run(voice);
    expect(mockSynthesize.mock.calls[0][1].voice).toBe('Puck');
  });

  it('keeps an explicit valid voice', async () => {
    await run('Charon');
    expect(mockSynthesize.mock.calls[0][1].voice).toBe('Charon');
  });

  it('passes the story language code and the base style when direction is off', async () => {
    await run();
    const [text, options] = mockSynthesize.mock.calls[0];
    expect(text).toBe('Once upon a time.');
    expect(options.languageCode).toBe('pt-PT');
    expect(options.style).toBe(BASE_STYLE);
    expect(options.segments).toBeUndefined();
  });

  it('does not build or pass a legacy systemPrompt for Gemini', async () => {
    await run();
    expect(mockGetTTSSystemPrompt).not.toHaveBeenCalled();
    expect(mockSynthesize.mock.calls[0][1]).not.toHaveProperty('systemPrompt');
  });

  it('builds the OpenAI instruction string only when the provider is openai', async () => {
    process.env.TTS_PROVIDER = 'openai';
    process.env.TTS_VOICE = 'coral';
    await run('coral');
    expect(mockGetTTSSystemPrompt).toHaveBeenCalledTimes(1);
    expect(mockSynthesize.mock.calls[0][1].systemPrompt).toBe('system prompt');
  });

  it('sends segments with "<baseStyle>; <mood>" styles when direction succeeds', async () => {
    mockShouldDirect.mockReturnValue(true);
    mockDirectNarration.mockResolvedValue({
      source: 'llm',
      segments: [
        { text: 'Once', mood: 'hushed' },
        { text: 'upon a time.', mood: 'bright' },
      ],
    });
    await run();
    expect(mockSynthesize.mock.calls[0][1].segments).toEqual([
      { text: 'Once', style: `${BASE_STYLE}; hushed` },
      { text: 'upon a time.', style: `${BASE_STYLE}; bright` },
    ]);
  });

  it('falls back to single text with the base style when direction falls back', async () => {
    mockShouldDirect.mockReturnValue(true);
    mockDirectNarration.mockResolvedValue({ source: 'fallback', segments: [] });
    await run();
    const [text, options] = mockSynthesize.mock.calls[0];
    expect(text).toBe('Once upon a time.');
    expect(options.style).toBe(BASE_STYLE);
    expect(options.segments).toBeUndefined();
  });

  it('sums usage across chunks and proxies chunks without provider usage', async () => {
    mockGetMaxTextLength.mockReturnValue(1000);
    // First chunk reports usage; later chunks do not
    mockSynthesize
      .mockResolvedValueOnce(ttsResult({ usage: { inputTokens: 100, outputTokens: 50 } }))
      .mockResolvedValue(ttsResult());

    await new TTSService().generateChapterAudioFromText('story-1', 2, LONG_CONTENT, 'Title');

    const calls = mockSynthesize.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    const proxyChars = calls.slice(1).reduce((sum, call) => sum + (call[0] as string).length, 0);
    const usage = mockRecordUsage.mock.calls[0][0];
    expect(usage.inputTokens).toBe(100 + proxyChars);
    expect(usage.outputTokens).toBe(50);
  });

  it('sums provider usage when every chunk reports it', async () => {
    mockGetMaxTextLength.mockReturnValue(1000);
    mockSynthesize.mockResolvedValue(ttsResult({ usage: { inputTokens: 10, outputTokens: 5 } }));

    await new TTSService().generateChapterAudioFromText('story-1', 2, LONG_CONTENT, 'Title');

    const n = mockSynthesize.mock.calls.length;
    expect(n).toBeGreaterThan(1);
    const usage = mockRecordUsage.mock.calls[0][0];
    expect(usage.inputTokens).toBe(10 * n);
    expect(usage.outputTokens).toBe(5 * n);
  });

  it('falls back to the default voice only for voice errors, not model/endpoint 404s', async () => {
    mockSynthesize
      .mockRejectedValueOnce(new Error('Invalid voice name: Foo'))
      .mockResolvedValueOnce(ttsResult());
    await run('Charon');
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
    expect(mockSynthesize.mock.calls[1][1].voice).toBe('Puck');

    mockSynthesize.mockReset();
    mockSynthesize.mockRejectedValue(new Error('404 models/gemini-x is not found'));
    await expect(run('Charon')).rejects.toThrow(/not found/);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
  });
});

describe('isVoiceError', () => {
  it('matches explicit voice errors and structured 400/404 mentioning the voice', () => {
    expect(isVoiceError(new Error('Voice not found: Foo'))).toBe(true);
    expect(isVoiceError(new Error('unsupported voice "Bar"'))).toBe(true);
    expect(isVoiceError(Object.assign(new Error('Bad voiceName'), { status: 400 }))).toBe(true);
    expect(isVoiceError(Object.assign(new Error('voice lookup'), { statusCode: 404 }))).toBe(true);
  });

  it('does not match generic 404 / not found errors', () => {
    expect(isVoiceError(new Error('404 Not Found'))).toBe(false);
    expect(isVoiceError(new Error('models/gemini-x is not found'))).toBe(false);
    expect(isVoiceError(Object.assign(new Error('Endpoint missing'), { status: 404 }))).toBe(false);
  });
});
