/**
 * Narration Direction
 * Optional per-chunk "audiobook director" pass for Gemini TTS. One text-LLM call splits a
 * chunk into 1-4 ordered segments, each with a short mood style, and may insert a few
 * whitelisted inline audio tags. Every result is validated by pure guardrails; any failure
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
  '<laughs>',
  '<chuckle>',
  '<giggle>',
  '<gasp>',
  '<whispers>',
  '<breath>',
] as const;

const ALLOWED_TAGS: ReadonlySet<string> = new Set(NARRATION_AUDIO_TAGS);
const TAG_PATTERN = /<[^<>\n]{1,40}>/g;

export const MAX_DIRECTION_SEGMENTS = 4;
export const WORDS_PER_INSERTED_TAG = 120;
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
  | 'unknown_tag'
  | 'too_many_tags'
  | 'verbatim_mismatch';

/** A validated segment: verbatim text (maybe with inserted tags) and an optional mood. */
export interface DirectedSegment {
  text: string;
  mood?: string;
}

export type DirectionValidation =
  | { ok: true; segments: DirectedSegment[]; insertedTags: number }
  | { ok: false; reason: NarrationDirectionFailureReason };

export type NarrationDirectionResult =
  | { source: 'llm'; segments: DirectedSegment[]; insertedTags: number }
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
 * Canonical form for the verbatim comparison: NFC, collapsed whitespace, and no
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

/** Remove whitelisted tags only; unknown `<...>` markup is left in place. */
export function stripAllowedTags(text: string): string {
  return text.replace(TAG_PATTERN, (match) => (ALLOWED_TAGS.has(match) ? ' ' : match));
}

function countTags(text: string): { allowedTotal: number; unknown: number } {
  let allowedTotal = 0;
  let unknown = 0;
  for (const match of text.match(TAG_PATTERN) ?? []) {
    if (ALLOWED_TAGS.has(match)) {
      allowedTotal += 1;
    } else {
      unknown += 1;
    }
  }
  return { allowedTotal, unknown };
}

function countSpokenWords(text: string): number {
  const canonical = canonicalizeTranscript(stripAllowedTags(text));
  return canonical ? canonical.split(' ').filter(Boolean).length : 0;
}

/** Density cap: one inserted tag per ~120 words, always allowing at least one. */
export function maxInsertedTags(text: string): number {
  return Math.max(1, Math.floor(countSpokenWords(text) / WORDS_PER_INSERTED_TAG));
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
  for (const item of rawSegments) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, reason: 'invalid_shape' };
    }
    const mood = sanitizeStyle((item as { style?: unknown }).style);
    segments.push({ text: text.trim(), ...(mood ? { mood } : {}) });
  }

  const joined = segments.map((segment) => segment.text).join(' ');
  const before = countTags(original);
  const after = countTags(joined);

  if (after.unknown > before.unknown) {
    return { ok: false, reason: 'unknown_tag' };
  }
  const insertedTags = after.allowedTotal - before.allowedTotal;
  if (insertedTags > maxInsertedTags(original)) {
    return { ok: false, reason: 'too_many_tags' };
  }
  if (
    canonicalizeTranscript(stripAllowedTags(joined)) !==
    canonicalizeTranscript(stripAllowedTags(original))
  ) {
    return { ok: false, reason: 'verbatim_mismatch' };
  }

  return { ok: true, segments, insertedTags };
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
  return env.TTS_DIRECTION_MODEL?.trim() || env.GOOGLE_GENAI_MODEL || 'gemini-3.6-flash';
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

  if (countSpokenWords(input.text) === 0) {
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
    styledSegments: validation.segments.filter((segment) => segment.mood).length,
  });

  return { source: 'llm', segments: validation.segments, insertedTags: validation.insertedTags };
}
