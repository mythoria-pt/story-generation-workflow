import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEnv = {
  TTS_EXPRESSIVE_DIRECTION_ENABLED: false,
  TTS_DIRECTION_MODEL: undefined as string | undefined,
  GOOGLE_GENAI_MODEL: 'gemini-3.6-flash',
};

jest.mock('@/config/environment.js', () => ({
  getEnvironment: () => mockEnv,
}));

const mockGatewayGetTextService = jest.fn<any>();
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({
    getTextServiceForProvider: mockGatewayGetTextService,
  }),
}));

jest.mock('@/config/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  NARRATION_AUDIO_TAGS,
  canonicalizeTranscript,
  composeStyle,
  directNarration,
  maxInsertedTags,
  sanitizeStyle,
  shouldDirectNarration,
  validateDirection,
} from '../services/narration-direction.js';
import { logger } from '../config/logger.js';

const ORIGINAL =
  'Chapter 1 - The Door.\n\nMia laughed at the tiny dragon. Then, suddenly, the door creaked open!';

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ') + '.';
}

describe('narration direction guardrails', () => {
  it('accepts a verbatim partition with one inserted tag', () => {
    const result = validateDirection(ORIGINAL, {
      segments: [
        {
          text: 'Chapter 1 - The Door. Mia laughed <laughs> at the tiny dragon.',
          style: 'light and amused',
        },
        { text: 'Then, suddenly, the door creaked open!', style: 'hushed and suspenseful' },
      ],
    });

    expect(result).toEqual({
      ok: true,
      insertedTags: 1,
      segments: [
        {
          text: 'Chapter 1 - The Door. Mia laughed <laughs> at the tiny dragon.',
          mood: 'light and amused',
        },
        { text: 'Then, suddenly, the door creaked open!', mood: 'hushed and suspenseful' },
      ],
    });
  });

  it('tolerates whitespace differences and a tag glued to punctuation', () => {
    const result = validateDirection('Hello there.  How are you?', {
      segments: [{ text: 'Hello there <sigh>.\nHow   are you?', style: '' }],
    });
    expect(result.ok).toBe(true);
    expect(canonicalizeTranscript('a  b ,c\n d')).toBe('a b,c d');
  });

  it('rejects any change to the words (verbatim guard)', () => {
    expect(
      validateDirection(ORIGINAL, {
        segments: [
          {
            text: 'Chapter 1 - The Door. Mia giggled at the tiny dragon. Then, suddenly, the door creaked open!',
            style: '',
          },
        ],
      }),
    ).toEqual({ ok: false, reason: 'verbatim_mismatch' });

    expect(validateDirection('One. Two.', { segments: [{ text: 'One.', style: '' }] })).toEqual({
      ok: false,
      reason: 'verbatim_mismatch',
    });
  });

  it('rejects unknown or square-bracket tags', () => {
    expect(
      validateDirection('She smiled.', { segments: [{ text: 'She <cries> smiled.', style: '' }] }),
    ).toEqual({ ok: false, reason: 'unknown_tag' });
    expect(
      validateDirection('She smiled.', { segments: [{ text: 'She [laughs] smiled.', style: '' }] }),
    ).toEqual({ ok: false, reason: 'verbatim_mismatch' });
  });

  it('rejects pause tags like any other unknown tag', () => {
    expect(
      validateDirection(ORIGINAL, {
        segments: [
          {
            text: 'Chapter 1 - The Door. <long pause> Mia laughed at the tiny dragon. Then, suddenly, the door creaked open!',
            style: '',
          },
        ],
      }),
    ).toEqual({ ok: false, reason: 'unknown_tag' });
    expect(
      validateDirection('One. Two.', {
        segments: [{ text: 'One. <short pause> Two.', style: '' }],
      }),
    ).toEqual({ ok: false, reason: 'unknown_tag' });
    expect(NARRATION_AUDIO_TAGS).not.toContain('<short pause>');
    expect(NARRATION_AUDIO_TAGS).not.toContain('<long pause>');
  });

  it('enforces the density cap of one inserted tag per ~120 words (minimum one)', () => {
    expect(maxInsertedTags('Short text.')).toBe(1);
    expect(maxInsertedTags(words(250))).toBe(2);
    expect(maxInsertedTags(`<sigh> ${words(119)}`)).toBe(1);

    expect(
      validateDirection('Short text here.', {
        segments: [{ text: '<sigh> Short <gasp> text here.', style: '' }],
      }),
    ).toEqual({ ok: false, reason: 'too_many_tags' });
  });

  it('rejects malformed shapes and bad segment counts', () => {
    expect(validateDirection('A.', null)).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(validateDirection('A.', { segments: [] })).toEqual({
      ok: false,
      reason: 'segment_count',
    });
    expect(
      validateDirection('A. B. C. D. E.', {
        segments: ['A.', 'B.', 'C.', 'D.', 'E.'].map((text) => ({ text, style: '' })),
      }),
    ).toEqual({ ok: false, reason: 'segment_count' });
    expect(validateDirection('A.', { segments: [{ text: '', style: 'x' }] })).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
  });

  it('sanitizes styles: trims, caps length, drops identity/accent/consistency words', () => {
    expect(sanitizeStyle('  hushed and suspenseful, slowing down.  ')).toBe(
      'hushed and suspenseful, slowing down',
    );
    expect(sanitizeStyle('')).toBeUndefined();
    expect(sanitizeStyle(42)).toBeUndefined();
    for (const bad of [
      'with a British accent',
      'like a Brazilian storyteller',
      'European Portuguese warmth',
      'like a 7-year-old',
      'an old man remembering',
      'cheerful girl voice',
      'deep male tone',
      'keep it consistent',
      'use the same voice',
    ]) {
      expect(sanitizeStyle(bad)).toBeUndefined();
    }
    const long = sanitizeStyle(
      'soft and slow and gentle and calm and quiet and tender and dreamy and drifting toward sleep now',
    );
    expect(long).toBeDefined();
    expect(long!.length).toBeLessThanOrEqual(80);
  });

  it('drops a forbidden style without rejecting the whole direction', () => {
    const result = validateDirection('She smiled.', {
      segments: [{ text: 'She smiled.', style: 'British accent' }],
    });
    expect(result).toEqual({ ok: true, insertedTags: 0, segments: [{ text: 'She smiled.' }] });
  });

  it('composes the final style from base style and mood', () => {
    expect(composeStyle('Warm storyteller', 'hushed')).toBe('Warm storyteller; hushed');
    expect(composeStyle('Warm storyteller', undefined)).toBe('Warm storyteller');
    expect(composeStyle(undefined, 'hushed')).toBe('hushed');
    expect(composeStyle(undefined, undefined)).toBeUndefined();
  });
});

describe('directNarration', () => {
  const complete = jest.fn<any>();
  const getTextService = jest.fn<any>(() => ({ complete }));
  const input = {
    text: ORIGINAL,
    storyLanguage: 'pt-PT',
    targetAge: 'children',
    authorId: 'author-1',
    storyId: 'story-1',
    chapterNumber: 1,
    chunkIndex: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.TTS_EXPRESSIVE_DIRECTION_ENABLED = false;
    mockEnv.TTS_DIRECTION_MODEL = undefined;
  });

  it('is gated by the flag and the Gemini provider', () => {
    expect(shouldDirectNarration('google-genai')).toBe(false);
    mockEnv.TTS_EXPRESSIVE_DIRECTION_ENABLED = true;
    expect(shouldDirectNarration('google-genai')).toBe(true);
    expect(shouldDirectNarration('openai')).toBe(false);
  });

  it('makes no LLM call when the flag is off', async () => {
    const result = await directNarration(input, { getTextService });

    expect(result).toEqual({ source: 'fallback', reason: 'disabled' });
    expect(getTextService).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  describe('with the flag on', () => {
    beforeEach(() => {
      mockEnv.TTS_EXPRESSIVE_DIRECTION_ENABLED = true;
    });

    it('returns validated segments and tracks the call as audio_generation/narration_direction', async () => {
      mockEnv.TTS_DIRECTION_MODEL = 'gemini-3.5-flash-lite';
      complete.mockResolvedValue(
        JSON.stringify({
          segments: [{ text: ORIGINAL, style: 'bright and curious' }],
        }),
      );

      const result = await directNarration(input, { getTextService });

      expect(result).toEqual({
        source: 'llm',
        insertedTags: 0,
        segments: [{ text: ORIGINAL, mood: 'bright and curious' }],
      });
      expect(getTextService).toHaveBeenCalledWith({
        authorId: 'author-1',
        storyId: 'story-1',
        action: 'audio_generation',
        operation: 'narration_direction',
      });
      const [prompt, options] = complete.mock.calls[0] as [string, Record<string, unknown>];
      expect(prompt).toContain(ORIGINAL);
      expect(prompt).toContain('<story_language>pt-PT</story_language>');
      expect(prompt).toContain('<whispers>');
      expect(options).toMatchObject({
        model: 'gemini-3.5-flash-lite',
        thinkingLevel: 'low',
        privateContent: true,
      });
      expect(options.jsonSchema).toBeDefined();
      expect(options.systemInstruction).toContain('audiobook director');
    });

    it('uses the tracked gateway with the default Gemini text model when no override is set', async () => {
      mockGatewayGetTextService.mockReturnValue({ complete });
      complete.mockResolvedValue(JSON.stringify({ segments: [{ text: ORIGINAL, style: '' }] }));

      await directNarration(input);

      expect(mockGatewayGetTextService).toHaveBeenCalledWith(
        'google-genai',
        expect.objectContaining({ operation: 'narration_direction' }),
      );
      expect((complete.mock.calls[0] as [string, { model: string }])[1].model).toBe(
        'gemini-3.6-flash',
      );
    });

    it('falls back on an LLM error and logs a structured warning', async () => {
      complete.mockRejectedValue(new Error('503 overloaded'));

      const result = await directNarration(input, { getTextService });

      expect(result).toEqual({ source: 'fallback', reason: 'llm_error' });
      expect(logger.warn).toHaveBeenCalledWith(
        'Narration direction fell back to the base style',
        expect.objectContaining({ reason: 'llm_error', storyId: 'story-1', chunkIndex: 0 }),
      );
    });

    it('falls back on bad JSON', async () => {
      complete.mockResolvedValue('not json at all');

      await expect(directNarration(input, { getTextService })).resolves.toEqual({
        source: 'fallback',
        reason: 'invalid_json',
      });
    });

    it('falls back when the response fails a guardrail', async () => {
      complete.mockResolvedValue(
        JSON.stringify({
          segments: [{ text: 'Something else entirely.', style: '' }],
        }),
      );

      await expect(directNarration(input, { getTextService })).resolves.toEqual({
        source: 'fallback',
        reason: 'verbatim_mismatch',
      });
    });

    it('falls back on timeout and aborts the request', async () => {
      let seenSignal: AbortSignal | undefined;
      complete.mockImplementation((_prompt: string, options: { signal: AbortSignal }) => {
        seenSignal = options.signal;
        return new Promise(() => undefined);
      });

      const result = await directNarration(input, { getTextService, timeoutMs: 5 });

      expect(result).toEqual({ source: 'fallback', reason: 'timeout' });
      expect(seenSignal?.aborted).toBe(true);
    });

    it('skips the LLM for text with no words', async () => {
      const result = await directNarration({ ...input, text: '<sigh>' }, { getTextService });

      expect(result).toEqual({ source: 'fallback', reason: 'empty_text' });
      expect(complete).not.toHaveBeenCalled();
    });
  });
});
