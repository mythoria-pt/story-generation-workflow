import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEnv = {
  TTS_EXPRESSIVE_DIRECTION_ENABLED: false,
  TTS_DIRECTION_MODEL: undefined as string | undefined,
  GOOGLE_GENAI_MODEL: 'gemini-4-hydrogen',
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
          text: 'Chapter 1 - The Door. Mia laughed <laugh> at the tiny dragon.',
          style: 'light and amused',
        },
        { text: 'Then, suddenly, the door creaked open!', style: 'hushed and suspenseful' },
      ],
    });

    expect(result).toEqual({
      ok: true,
      insertedTags: 1,
      discardedTags: 0,
      adaptedText: false,
      segments: [
        {
          text: 'Chapter 1 - The Door. Mia laughed <laugh> at the tiny dragon.',
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

  it('accepts small spoken-language changes while retaining segment moods', () => {
    expect(
      validateDirection(ORIGINAL, {
        segments: [
          {
            text: 'Chapter 1 - The Door. Mia giggled at the tiny dragon. Then, suddenly, the door creaked open!',
            style: '',
          },
        ],
      }),
    ).toMatchObject({ ok: true, adaptedText: true });

    expect(validateDirection('One. Two.', { segments: [{ text: 'One.', style: '' }] })).toEqual({
      ok: false,
      reason: 'content_drift',
    });
  });

  it.each([
    [
      'I cannot believe it. We have finally found our way home!',
      "I can't believe it... We've finally found our way home!",
    ],
    [
      'Não consigo acreditar. Finalmente, chegámos a casa!',
      'Não consigo acreditar... Finalmente chegámos a casa!',
    ],
    [
      '¡No puedo creerlo! Por fin hemos llegado a casa.',
      '¡No puedo creerlo! Al fin hemos llegado a casa.',
    ],
    [
      'Je ne peux pas le croire. Nous sommes enfin chez nous !',
      'Je ne peux pas le croire... Nous sommes enfin chez nous !',
    ],
    [
      'Ich kann es nicht glauben. Endlich sind wir wieder zu Hause!',
      'Ich kann es kaum glauben... Endlich sind wir wieder zu Hause!',
    ],
  ])('accepts minor adaptations across the supported locales: %s', (original, directed) => {
    expect(
      validateDirection(original, { segments: [{ text: directed, style: 'delighted relief' }] }),
    ).toMatchObject({ ok: true, adaptedText: true });
  });

  it('rejects broad rewrites, reordered scenes, truncation and duplicated passages', () => {
    const original = words(40);
    for (const text of [
      words(15),
      words(40) + ' ' + words(40),
      'An entirely unrelated adventure with different people.',
      original.split(' ').reverse().join(' '),
    ]) {
      expect(validateDirection(original, { segments: [{ text, style: 'lively' }] })).toEqual({
        ok: false,
        reason: 'content_drift',
      });
    }
  });

  it('removes unsupported cues without rejecting the text or style', () => {
    expect(
      validateDirection('She smiled.', {
        segments: [{ text: 'She <applause>smiled.', style: 'warm amusement' }],
      }),
    ).toMatchObject({
      ok: true,
      discardedTags: 1,
      segments: [{ text: 'She  smiled.', mood: 'warm amusement' }],
    });
  });

  it('normalizes supported bracket cues to documented angle-bracket spelling', () => {
    expect(
      validateDirection('She smiled.', {
        segments: [{ text: 'She [LAUGH] smiled.', style: 'amused' }],
      }),
    ).toMatchObject({
      ok: true,
      insertedTags: 1,
      segments: [{ text: 'She <laugh> smiled.', mood: 'amused' }],
    });
    expect(NARRATION_AUDIO_TAGS).toContain('<laugh>');
    expect(NARRATION_AUDIO_TAGS).toContain('<sob>');
    expect(NARRATION_AUDIO_TAGS).toContain('<exhales>');
    expect(NARRATION_AUDIO_TAGS).not.toContain('<laughs>');
  });

  it('removes pause tags without losing expressive direction', () => {
    expect(
      validateDirection(ORIGINAL, {
        segments: [
          {
            text: 'Chapter 1 - The Door. <long pause> Mia laughed at the tiny dragon. Then, suddenly, the door creaked open!',
            style: '',
          },
        ],
      }),
    ).toMatchObject({ ok: true, discardedTags: 1 });
    expect(
      validateDirection('One. Two.', {
        segments: [{ text: 'One. <short pause> Two.', style: '' }],
      }),
    ).toMatchObject({ ok: true, discardedTags: 1 });
    expect(NARRATION_AUDIO_TAGS).not.toContain('<short pause>');
    expect(NARRATION_AUDIO_TAGS).not.toContain('<long pause>');
  });

  it('allows more expressive cues and trims surplus cues instead of rejecting direction', () => {
    expect(maxInsertedTags('Short text.')).toBe(2);
    expect(maxInsertedTags(words(250))).toBe(5);
    expect(maxInsertedTags(`<sigh> ${words(119)}`)).toBe(2);
    expect(maxInsertedTags(words(2000))).toBe(16);

    expect(
      validateDirection('Short text here.', {
        segments: [
          { text: '<sigh> Short <gasp> text <breath> here.', style: 'breathless anticipation' },
        ],
      }),
    ).toMatchObject({
      ok: true,
      insertedTags: 2,
      discardedTags: 1,
      segments: [expect.objectContaining({ mood: 'breathless anticipation' })],
    });
  });

  it('applies the cue budget across all segments', () => {
    expect(
      validateDirection('One. Two.', {
        segments: [
          { text: '<sigh> One.', style: 'thoughtful' },
          { text: '<gasp> Two. <laugh>', style: 'surprised' },
        ],
      }),
    ).toMatchObject({ ok: true, insertedTags: 2, discardedTags: 1 });
  });

  it('accepts a vocal-event segment and removes an unsupported cue-only segment', () => {
    expect(
      validateDirection('She smiled.', {
        segments: [
          { text: '<applause>', style: '' },
          { text: '<chuckle>', style: 'amused' },
          { text: 'She smiled.', style: 'warm' },
        ],
      }),
    ).toMatchObject({
      ok: true,
      insertedTags: 1,
      discardedTags: 1,
      segments: [
        { text: '<chuckle>', mood: 'amused' },
        { text: 'She smiled.', mood: 'warm' },
      ],
    });
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
    expect(result).toMatchObject({
      ok: true,
      insertedTags: 0,
      segments: [{ text: 'She smiled.' }],
    });
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
      mockEnv.TTS_DIRECTION_MODEL = 'gemini-4-hydrogen';
      complete.mockResolvedValue(
        JSON.stringify({
          segments: [{ text: ORIGINAL, style: 'bright and curious' }],
        }),
      );

      const result = await directNarration(input, { getTextService });

      expect(result).toEqual({
        source: 'llm',
        insertedTags: 0,
        discardedTags: 0,
        adaptedText: false,
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
        model: 'gemini-4-hydrogen',
        thinkingLevel: 'low',
        privateContent: true,
      });
      expect(options.jsonSchema).toBeDefined();
      expect(options.systemInstruction).toContain('audiobook director');
      expect(options.systemInstruction).toContain('small spoken-language adjustments');
      expect(prompt).not.toContain('Copy the transcript EXACTLY');
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
        'gemini-4-hydrogen',
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
        reason: 'content_drift',
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
