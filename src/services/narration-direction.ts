/**
 * Narration Direction
 * Optional per-chunk "audiobook director" pass for Gemini TTS. One text-LLM call splits a
 * chunk into 1-4 ordered segments, each with a short mood style, and may insert a few
 * documented inline audio tags and make small spoken-language edits. Invalid content
 * falls back to the untouched chunk with the base style. Narration is never blocked.
 */

import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import type { AICallContext } from '@/ai/token-tracking-middleware.js';
import type { ITextGenerationService, TTSProvider } from '@/ai/interfaces.js';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import { parseAIResponse } from '@/shared/utils.js';
import { PromptService } from './prompt.js';

/**
 * Inline audio tags the director may use (Gemini 3.8 angle-bracket syntax, English only).
 * Vocalizations only: pause tags are deliberately excluded because the model can read them aloud.
 */
export const NARRATION_AUDIO_TAGS = [
  '<sigh>',
  '<sighs>',
  '<laugh>',
  '<laughter>',
  '<chuckle>',
  '<chuckles>',
  '<giggle>',
  '<gasp>',
  '<whispers>',
  '<whispering>',
  '<breath>',
  '<heavy breath>',
  '<exhales>',
  '<cough>',
  '<throat-clearing>',
  '<cry>',
  '<sob>',
  '<whimper>',
  '<snicker>',
  '<snort>',
  '<phew>',
  '<yawn>',
  '<groan>',
  '<cheer>',
] as const;

const ALLOWED_TAGS: ReadonlySet<string> = new Set(NARRATION_AUDIO_TAGS);
const TAG_PATTERN = /<[^<>\n]{1,40}>|\[[^[\]\n]{1,40}\]/g;
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

export const MAX_DIRECTION_SEGMENTS = 4;
export const WORDS_PER_INSERTED_TAG = 60;
export const MAX_NARRATION_EDIT_RATIO = 0.25;
export const MAX_STYLE_LENGTH = 80;
export const NARRATION_DIRECTION_TIMEOUT_MS = 20000;
const DIRECTION_MAX_OUTPUT_TOKENS = 8192;

/** Words that steer voice identity/accent/consistency and cause voice drift in Gemini TTS. */
const FORBIDDEN_STYLE_PATTERN =
  /\b(accents?|british|american|brazilian|portuguese|spanish|french|german|english|european|year[- ]old|years? old|old (?:man|woman|lady)|girl|boy|male|female|man|woman|gender|child|kid|elderly|teen(?:ager)?|consistent|consistency|same voice|voice identity)\b/i;

export type NarrationDirectionFailureReason =
  | 'disabled'
  | 'empty_text'
  | 'llm_error'
  | 'timeout'
  | 'invalid_json'
  | 'invalid_shape'
  | 'segment_count'
  | 'content_drift';

/** A narration-adapted segment, with supported inline cues and an optional mood. */
export interface DirectedSegment {
  text: string;
  mood?: string;
}

export type DirectionValidation =
  | {
      ok: true;
      segments: DirectedSegment[];
      insertedTags: number;
      discardedTags: number;
      adaptedText: boolean;
    }
  | { ok: false; reason: NarrationDirectionFailureReason };

export type NarrationDirectionResult =
  | {
      source: 'llm';
      segments: DirectedSegment[];
      insertedTags: number;
      discardedTags: number;
      adaptedText: boolean;
    }
  | { source: 'fallback'; reason: NarrationDirectionFailureReason };

export interface NarrationDirectionInput {
  text: string;
  storyLanguage: string;
  /** Audio target age key (toddlers, children, young adults, adults, general audience) */
  targetAge?: string | undefined;
  authorId: string;
  storyId: string;
  chapterNumber?: number | undefined;
  chunkIndex: number;
}

export interface NarrationDirectionDeps {
  getTextService?: (context: AICallContext) => ITextGenerationService;
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure guardrails
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical form for recording whether narration was adapted: NFC, collapsed whitespace, and no
 * whitespace next to punctuation (so a removed tag never leaves a stray space).
 */
export function canonicalizeTranscript(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:…»”’)\]])/g, '$1')
    .replace(/([«“‘(¿¡[])\s+/g, '$1')
    .trim();
}

/** Remove supported vocal tags; other markup is left in place. */
export function stripAllowedTags(text: string): string {
  return text.replace(TAG_PATTERN, (match) =>
    ALLOWED_TAGS.has(normalizeTag(match)) ? ' ' : match,
  );
}

function normalizeTag(tag: string): string {
  return `<${tag.slice(1, -1).trim().toLowerCase()}>`;
}

function spokenWords(text: string): string[] {
  return Array.from(WORD_SEGMENTER.segment(stripAllowedTags(text).normalize('NFC').toLowerCase()))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

/** Room for expressive cues: roughly one per 60 words, at least two and at most 16. */
export function maxInsertedTags(text: string): number {
  return Math.min(16, Math.max(2, Math.ceil(spokenWords(text).length / WORDS_PER_INSERTED_TAG)));
}

/** Lexical bound, not a semantic proof: permit minor edits, reject broad rewrites/truncation. */
function hasContentDrift(original: string, directed: string): boolean {
  const before = spokenWords(original);
  const after = spokenWords(directed);
  const budget = Math.max(3, Math.floor(before.length * MAX_NARRATION_EDIT_RATIO));
  if (after.length < Math.ceil(before.length * (1 - MAX_NARRATION_EDIT_RATIO))) return true;
  if (Math.abs(before.length - after.length) > budget) return true;
  let previous = Array.from({ length: after.length + 1 }, (_, index) => index);
  for (let i = 1; i <= before.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= after.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? Infinity) + 1,
        (current[j - 1] ?? Infinity) + 1,
        (previous[j - 1] ?? Infinity) + (before[i - 1] === after[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > budget) return true;
    previous = current;
  }
  return (previous[after.length] ?? Infinity) > budget;
}

/**
 * Clean a mood line from the director. Returns undefined when it is empty or mentions
 * accent, age, gender, identity or consistency (those cause voice drift).
 */
export function sanitizeStyle(style: unknown): string | undefined {
  if (typeof style !== 'string') return undefined;
  let cleaned = style
    .replace(/[<>[\]{}"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,]+$/, '');
  if (!cleaned) return undefined;
  if (FORBIDDEN_STYLE_PATTERN.test(cleaned)) return undefined;
  if (cleaned.length > MAX_STYLE_LENGTH) {
    const cut = cleaned.slice(0, MAX_STYLE_LENGTH);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s.;,]+$/, '');
  }
  return cleaned || undefined;
}

/** Final per-segment style: the story base style plus this segment's mood. */
export function composeStyle(
  baseStyle: string | undefined,
  mood: string | undefined,
): string | undefined {
  const base = baseStyle?.trim();
  const extra = mood?.trim();
  if (base && extra) return `${base}; ${extra}`;
  return base || extra || undefined;
}

/**
 * Validate a parsed director response against the original chunk.
 */
export function validateDirection(original: string, raw: unknown): DirectionValidation {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { segments?: unknown }).segments)) {
    return { ok: false, reason: 'invalid_shape' };
  }
  const rawSegments = (raw as { segments: unknown[] }).segments;
  if (rawSegments.length < 1 || rawSegments.length > MAX_DIRECTION_SEGMENTS) {
    return { ok: false, reason: 'segment_count' };
  }

  const segments: DirectedSegment[] = [];
  let keptTags = 0;
  let discardedTags = 0;
  const tagBudget = maxInsertedTags(original);
  for (const item of rawSegments) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, reason: 'invalid_shape' };
    }
    const mood = sanitizeStyle((item as { style?: unknown }).style);
    const cleaned = text
      .replace(TAG_PATTERN, (match) => {
        const tag = normalizeTag(match);
        if (ALLOWED_TAGS.has(tag) && keptTags < tagBudget) {
          keptTags += 1;
          return tag;
        }
        discardedTags += 1;
        return ' ';
      })
      .trim();
    if (!cleaned) continue;
    segments.push({ text: cleaned, ...(mood ? { mood } : {}) });
  }
  if (segments.length === 0) return { ok: false, reason: 'invalid_shape' };

  const joined = segments.map((segment) => segment.text).join(' ');
  if (hasContentDrift(original, joined)) return { ok: false, reason: 'content_drift' };
  const originalTags = (original.match(TAG_PATTERN) ?? []).filter((tag) =>
    ALLOWED_TAGS.has(normalizeTag(tag)),
  ).length;
  const adaptedText =
    canonicalizeTranscript(stripAllowedTags(joined)) !==
    canonicalizeTranscript(stripAllowedTags(original));

  return {
    ok: true,
    segments,
    insertedTags: Math.max(0, keptTags - originalTags),
    discardedTags,
    adaptedText,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

/** Feature flag (TTS_EXPRESSIVE_DIRECTION_ENABLED, default false). */
export function isNarrationDirectionEnabled(): boolean {
  return getEnvironment().TTS_EXPRESSIVE_DIRECTION_ENABLED === true;
}

/** Direction only runs when the flag is on and the narration provider is Gemini. */
export function shouldDirectNarration(provider: TTSProvider): boolean {
  return provider === 'google-genai' && isNarrationDirectionEnabled();
}

/** Text model for the director: TTS_DIRECTION_MODEL, else the default Gemini text model. */
export function getNarrationDirectionModel(): string {
  const env = getEnvironment();
  return env.TTS_DIRECTION_MODEL?.trim() || env.GOOGLE_GENAI_MODEL || 'gemini-4-hydrogen';
}

const AUDIENCE_GUIDANCE: Record<string, string> = {
  toddlers:
    'Very young listeners: keep every mood gentle, soft and soothing. No scary intensity, no sudden loud moments.',
  children:
    'Children: playful and warm. Suspense stays light and safe, never frightening or intense.',
  'young adults': 'Teens: expressive and lively; tension is fine but keep it tasteful.',
  adults: 'Adults: the full emotional range is fine, but stay natural and restrained.',
  'general audience': 'Family listening: warm and expressive, never frightening or intense.',
};

function audienceGuidance(targetAge: string | undefined): string {
  return AUDIENCE_GUIDANCE[targetAge ?? ''] ?? (AUDIENCE_GUIDANCE['general audience'] as string);
}

const DIRECTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_DIRECTION_SEGMENTS,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          style: { type: 'string' },
        },
        required: ['text', 'style'],
      },
    },
  },
  required: ['segments'],
};

class NarrationDirectionTimeoutError extends Error {}

/**
 * Direct one narration chunk. Never throws: every failure returns a fallback result
 * (and logs a structured warning) so the caller narrates the chunk with its base style.
 */
export async function directNarration(
  input: NarrationDirectionInput,
  deps: NarrationDirectionDeps = {},
): Promise<NarrationDirectionResult> {
  const logContext = {
    storyId: input.storyId,
    chapterNumber: input.chapterNumber,
    chunkIndex: input.chunkIndex,
    textLength: input.text.length,
  };
  const fallback = (
    reason: NarrationDirectionFailureReason,
    extra: Record<string, unknown> = {},
  ): NarrationDirectionResult => {
    logger.warn('Narration direction fell back to the base style', {
      ...logContext,
      reason,
      ...extra,
    });
    return { source: 'fallback', reason };
  };

  // Defensive gate: callers check shouldDirectNarration(), but the flag is authoritative.
  if (!isNarrationDirectionEnabled()) {
    return { source: 'fallback', reason: 'disabled' };
  }

  if (spokenWords(input.text).length === 0) {
    return fallback('empty_text');
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  const model = getNarrationDirectionModel();

  try {
    const template = await PromptService.loadPrompt('en-US', 'narration-direction');
    const { systemInstruction, userPrompt } = PromptService.buildParts(template, {
      storyLanguage: input.storyLanguage,
      targetAudience: input.targetAge || 'general audience',
      audienceGuidance: audienceGuidance(input.targetAge),
      allowedTags: NARRATION_AUDIO_TAGS.join(', '),
      maxTags: String(maxInsertedTags(input.text)),
      transcript: input.text,
    });

    const context: AICallContext = {
      authorId: input.authorId,
      storyId: input.storyId,
      // ai_action_type has no narration value; share audio_generation and tag the operation
      action: 'audio_generation',
      operation: 'narration_direction',
    };
    const service = deps.getTextService
      ? deps.getTextService(context)
      : getAIGatewayWithTokenTracking().getTextServiceForProvider('google-genai', context);

    const work = service.complete(userPrompt, {
      model,
      systemInstruction,
      jsonSchema: DIRECTION_JSON_SCHEMA,
      maxTokens: DIRECTION_MAX_OUTPUT_TOKENS,
      thinkingLevel: 'low',
      signal: controller.signal,
      privateContent: true,
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new NarrationDirectionTimeoutError('Narration direction timed out'));
      }, deps.timeoutMs ?? NARRATION_DIRECTION_TIMEOUT_MS);
    });
    raw = await Promise.race([work, deadline]);
  } catch (error) {
    if (error instanceof NarrationDirectionTimeoutError) {
      return fallback('timeout', { model });
    }
    return fallback('llm_error', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = parseAIResponse(raw);
  } catch {
    return fallback('invalid_json', { model });
  }

  const validation = validateDirection(input.text, parsed);
  if (!validation.ok) {
    return fallback(validation.reason, { model });
  }

  logger.info('Narration direction applied', {
    ...logContext,
    model,
    segmentCount: validation.segments.length,
    insertedTags: validation.insertedTags,
    discardedTags: validation.discardedTags,
    adaptedText: validation.adaptedText,
    styledSegments: validation.segments.filter((segment) => segment.mood).length,
  });

  return {
    source: 'llm',
    segments: validation.segments,
    insertedTags: validation.insertedTags,
    discardedTags: validation.discardedTags,
    adaptedText: validation.adaptedText,
  };
}
