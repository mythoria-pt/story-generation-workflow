/**
 * Model pricing table (pure data + pure resolver, no I/O).
 *
 * All rates are USD per 1M tokens unless noted. Entries are ordered
 * most-specific-first: the first entry whose `match` list has a substring of the
 * model name (and whose provider matches) wins. Each entry may carry several
 * dated tiers; the latest tier whose `effectiveFrom` (ISO date, UTC) is on or before
 * the request timestamp applies.
 *
 * Sources (official pricing audit, 2026-10-27; Standard tier, not Batch/Flex):
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
 *   (Vertex Global matches the Gemini API rates below; Vertex non-global endpoints are
 *   ~10% higher and are not modelled because SGW calls the Gemini API)
 * - https://developers.openai.com/api/docs/pricing
 * - https://developers.openai.com/api/docs/guides/image-generation
 */

export type PricingProvider = 'openai' | 'google-genai';
export type PricingKind = 'text' | 'image' | 'tts';
export type ImageResolution = '1K' | '2K' | '4K';
export type ImageQualityLevel = 'low' | 'medium' | 'high';

/** Per-image prices by quality for square (1024x1024) and non-square (1024x1536 / 1536x1024) sizes. */
export interface PerImageByQuality {
  square: Record<ImageQualityLevel, number>;
  nonSquare: Record<ImageQualityLevel, number>;
}

/**
 * Long-context surcharge: when a request's input tokens exceed `inputTokensAbove`, the whole
 * request (not just the excess) is billed at the multiplied rates.
 */
export interface LongContextPricing {
  inputTokensAbove: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

/**
 * How the cost is computed for an entry.
 * - `tokens`: plain input / cached input / output token billing.
 * - `image-count`: images are estimated from output tokens (`tokensPerImage` + `imageCountRounding`)
 *   and billed per image, plus input tokens and (optionally) text output tokens.
 * - `image-split`: one image per request billed per image (or per image output token when a
 *   split is known) plus text/thinking output tokens and input tokens.
 */
export type PricingBilling = 'tokens' | 'image-count' | 'image-split';

export interface PricingTier {
  /** ISO date (UTC midnight). Omitted on the base tier. */
  effectiveFrom?: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  /** Text / thinking / audio output rate. 0 when output tokens are not billed separately. */
  outputPer1M: number;
  /** Image output token rate (image-split billing). */
  imageOutputPer1M?: number;
  /** Flat price per generated image (standard quality / default). */
  perImage?: number;
  /** Flat price per image for `hd` quality. */
  perImageHd?: number;
  /** Quality- and size-specific price per image; takes precedence over perImage/perImageHd. */
  perImageByQuality?: PerImageByQuality;
  /** Long-context surcharge for token billing. */
  longContext?: LongContextPricing;
  /** Output tokens consumed by one image (used to estimate image count). */
  tokensPerImage?: number;
  /** Rounding used when estimating image count from output tokens. */
  imageCountRounding?: 'floor' | 'ceil';
  /** Resolution-specific price per image (image-split billing). */
  perImageByResolution?: Partial<Record<ImageResolution, number>>;
  /** Resolution-specific output tokens per image (image-split billing). */
  tokensPerImageByResolution?: Partial<Record<ImageResolution, number>>;
  /** Resolution used when the request does not state one. */
  defaultResolution?: ImageResolution;
}

export interface ModelPricing {
  match: string[];
  provider: PricingProvider;
  kind: PricingKind;
  billing: PricingBilling;
  tiers: PricingTier[];
  note?: string;
}

export interface ResolvedPricing {
  entry: ModelPricing;
  tier: PricingTier;
}

/** Approximate conversion rate: 1 USD = 0.92 EUR. */
export const USD_TO_EUR = 0.92;

/** Model whose rates are used for unknown Google models. */
export const GOOGLE_FALLBACK_MODEL = 'gemini-3.8-flash';

/** Model whose rates are used for unknown Google TTS models (never text rates). */
export const GOOGLE_TTS_FALLBACK_MODEL = 'gemini-3.8-flash-tts';

const GPT6_LONG_CONTEXT: LongContextPricing = {
  inputTokensAbove: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
};

/** gpt-image-2 published per-image output estimates (USD). */
const GPT_IMAGE_2_PER_IMAGE: PerImageByQuality = {
  square: { low: 0.006, medium: 0.053, high: 0.211 },
  nonSquare: { low: 0.005, medium: 0.041, high: 0.165 },
};

export const MODEL_PRICING: ModelPricing[] = [
  // ---------------------------------------------------------------- OpenAI text
  // GPT-6.x: requests above 272K input tokens are billed at 2x input/cached and 1.5x output
  // for the whole request.
  {
    match: ['gpt-6.1-sol'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      {
        inputPer1M: 2.0,
        cachedInputPer1M: 0.1,
        outputPer1M: 10.0,
        longContext: GPT6_LONG_CONTEXT,
      },
    ],
  },
  {
    match: ['gpt-6.1-terra'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      {
        inputPer1M: 1.0,
        cachedInputPer1M: 0.05,
        outputPer1M: 5.0,
        longContext: GPT6_LONG_CONTEXT,
      },
    ],
  },
  {
    // Official ID is gpt-6-luna; gpt-6.1-luna is not a published model and is only matched
    // defensively in case it is configured by mistake.
    match: ['gpt-6-luna', 'gpt-6.1-luna'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      {
        inputPer1M: 0.1,
        cachedInputPer1M: 0.01,
        outputPer1M: 0.5,
        longContext: GPT6_LONG_CONTEXT,
      },
    ],
  },
  {
    match: ['gpt-5.5-pro'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    // No cached discount published; cached treated as regular input.
    tiers: [{ inputPer1M: 30.0, cachedInputPer1M: 30.0, outputPer1M: 180.0 }],
  },
  {
    match: ['gpt-5.5'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 30.0 }],
  },
  {
    match: ['gpt-5.4-mini'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 }],
  },
  {
    match: ['gpt-5.4-nano'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.25 }],
  },
  {
    match: ['gpt-5.4'],
    provider: 'openai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15.0 }],
  },

  // --------------------------------------------------------------- OpenAI image
  {
    // Token rates are confirmed identical to gpt-image-2 (text in $5, cached text $1.25,
    // image in $8, cached image $2, image out $30 per 1M), but OpenAI publishes no fixed
    // per-image table for 2.5 (only an estimating calculator). The per-image figures below
    // are gpt-image-2's published estimates, used as an approximation: the image tool's
    // output tokens are not reported in the Responses API usage SGW receives.
    match: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
    provider: 'openai',
    kind: 'image',
    billing: 'image-count',
    note: 'Approximation: per-image cost borrowed from gpt-image-2 (same token rates)',
    tiers: [
      {
        inputPer1M: 5.0,
        cachedInputPer1M: 1.25,
        outputPer1M: 0,
        perImage: 0.053,
        perImageHd: 0.211,
        perImageByQuality: GPT_IMAGE_2_PER_IMAGE,
        tokensPerImage: 1000,
        imageCountRounding: 'ceil',
      },
    ],
  },
  {
    // Published per-image output estimates (exclude prompt and reference-image input tokens).
    match: ['gpt-image-2'],
    provider: 'openai',
    kind: 'image',
    billing: 'image-count',
    tiers: [
      {
        inputPer1M: 5.0,
        cachedInputPer1M: 1.25,
        outputPer1M: 0,
        perImage: 0.053,
        perImageHd: 0.211,
        perImageByQuality: GPT_IMAGE_2_PER_IMAGE,
        tokensPerImage: 1000,
        imageCountRounding: 'ceil',
      },
    ],
  },
  {
    // Per-image (square 1024x1024): low $0.009, medium $0.034, high $0.133.
    match: ['gpt-image-1.5'],
    provider: 'openai',
    kind: 'image',
    billing: 'image-count',
    tiers: [
      {
        inputPer1M: 5.0,
        cachedInputPer1M: 1.25,
        outputPer1M: 10.0, // text output incl. reasoning
        perImage: 0.034,
        perImageHd: 0.133,
        tokensPerImage: 1000,
        imageCountRounding: 'ceil',
      },
    ],
  },

  // ----------------------------------------------------------------- OpenAI TTS
  {
    match: ['gpt-4o-mini-tts'],
    provider: 'openai',
    kind: 'tts',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.6, cachedInputPer1M: 0.06, outputPer1M: 12.0 }],
  },

  // ---------------------------------------------------------------- Google TTS
  // Must stay ahead of every Google text entry: 'gemini-3.8-flash-tts' contains the
  // 'gemini-3.8-flash' text match. Audio output is billed at the output rate.
  // Promotional rates end 2026-12-31.
  {
    match: ['gemini-3.8-flash-tts'],
    provider: 'google-genai',
    kind: 'tts',
    billing: 'tokens',
    tiers: [
      { inputPer1M: 0.5, cachedInputPer1M: 0.05, outputPer1M: 9.0 },
      { effectiveFrom: '2027-01-01', inputPer1M: 1.0, cachedInputPer1M: 0.1, outputPer1M: 18.0 },
    ],
  },

  // ---------------------------------------------------------------- Google text
  {
    match: ['gemini-4-argon'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      { inputPer1M: 2.0, cachedInputPer1M: 0.1, outputPer1M: 10.0 },
      { effectiveFrom: '2026-12-01', inputPer1M: 4.0, cachedInputPer1M: 0.2, outputPer1M: 20.0 },
    ],
  },
  {
    match: ['gemini-3.8-flash'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 3.75 },
      { effectiveFrom: '2027-01-01', inputPer1M: 1.5, cachedInputPer1M: 0.15, outputPer1M: 7.5 },
    ],
  },
  {
    // Corrected 2026-10-27 (was 1.50 / 0.15 / 7.50); same schedule as 3.8 Flash.
    match: ['gemini-3.6-flash'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [
      { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 3.75 },
      { effectiveFrom: '2027-01-01', inputPer1M: 1.5, cachedInputPer1M: 0.15, outputPer1M: 7.5 },
    ],
  },
  {
    // Must precede gemini-3.5-flash.
    match: ['gemini-3.5-flash-lite'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.3, cachedInputPer1M: 0.03, outputPer1M: 2.5 }],
  },
  {
    match: ['gemini-3.5-flash'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 1.5, cachedInputPer1M: 0.15, outputPer1M: 9.0 }],
  },
  {
    // Image variant must precede the text lite entry so it is never priced as text.
    // 1K output only: input $0.25, text/thinking $1.50, image out $30 per 1M (1120 tokens = $0.0336).
    match: ['gemini-3.1-flash-lite-image'],
    provider: 'google-genai',
    kind: 'image',
    billing: 'image-split',
    tiers: [
      {
        inputPer1M: 0.25,
        cachedInputPer1M: 0.25,
        outputPer1M: 1.5,
        imageOutputPer1M: 30.0,
        defaultResolution: '1K',
        perImageByResolution: { '1K': 0.0336 },
        tokensPerImageByResolution: { '1K': 1120 },
      },
    ],
  },
  {
    match: ['gemini-3.1-flash-lite'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.25, cachedInputPer1M: 0.025, outputPer1M: 1.5 }],
  },
  {
    match: ['gemini-3.1-pro'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 2.0, cachedInputPer1M: 0.2, outputPer1M: 12.0 }],
  },

  // --------------------------------------------------------------- Google image
  {
    // Nano Banana 2.1: input $1.50, text/thinking output $7.50, image output $30.00 per 1M.
    // Tokens per image: 1K=1120, 2K=1680, 4K=3780. SGW requests 2K.
    // Cached input $0.15 is the Vertex rate (not listed for the Gemini API, which has no caching here).
    match: ['gemini-nano-banana-2.1'],
    provider: 'google-genai',
    kind: 'image',
    billing: 'image-split',
    tiers: [
      {
        inputPer1M: 1.5,
        cachedInputPer1M: 0.15,
        outputPer1M: 7.5,
        imageOutputPer1M: 30.0,
        defaultResolution: '2K',
        perImageByResolution: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
        tokensPerImageByResolution: { '1K': 1120, '2K': 1680, '4K': 3780 },
      },
    ],
  },
  {
    // 1K/2K images consume 1120 tokens (~$0.134/image); 4K ~2000 tokens (~$0.24/image).
    match: ['gemini-3-pro-image'],
    provider: 'google-genai',
    kind: 'image',
    billing: 'image-count',
    tiers: [
      {
        inputPer1M: 2.0,
        cachedInputPer1M: 0.2,
        outputPer1M: 0,
        perImage: 0.134,
        tokensPerImage: 1120,
        imageCountRounding: 'floor',
      },
    ],
  },
  {
    // Image output $60/1M: 1K=1120 tokens (~$0.067), 2K=1680 (~$0.101), 4K=2520 (~$0.151).
    match: ['gemini-3.1-flash-image', 'gemini-3-flash-image'],
    provider: 'google-genai',
    kind: 'image',
    billing: 'image-count',
    tiers: [
      {
        inputPer1M: 0.25,
        cachedInputPer1M: 0.25,
        outputPer1M: 0,
        perImage: 0.067,
        tokensPerImage: 1120,
        imageCountRounding: 'floor',
      },
    ],
  },
  {
    // ~1290 tokens per image at $0.039/image.
    match: ['gemini-2.5-flash-image'],
    provider: 'google-genai',
    kind: 'image',
    billing: 'image-count',
    tiers: [
      {
        inputPer1M: 0.3,
        cachedInputPer1M: 0.3,
        outputPer1M: 0,
        perImage: 0.039,
        tokensPerImage: 1290,
        imageCountRounding: 'floor',
      },
    ],
  },

  // ---------------------------------------------------- Google text (older) / TTS
  {
    // Gemini 3 Pro Preview - deprecated March 9, 2026 (migrate to gemini-3.1-pro-preview).
    match: ['gemini-3-pro-preview'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 2.0, cachedInputPer1M: 0.2, outputPer1M: 12.0 }],
  },
  {
    // Must come after gemini-3-flash-image.
    match: ['gemini-3-flash'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.5, cachedInputPer1M: 0.05, outputPer1M: 3.0 }],
  },
  {
    match: ['gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-tts'],
    provider: 'google-genai',
    kind: 'tts',
    billing: 'tokens',
    tiers: [{ inputPer1M: 1.0, cachedInputPer1M: 0.1, outputPer1M: 20.0 }],
  },
  {
    match: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'],
    provider: 'google-genai',
    kind: 'tts',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.5, cachedInputPer1M: 0.05, outputPer1M: 10.0 }],
  },
  {
    // Must come after gemini-2.5-flash-image and the TTS entries.
    match: ['gemini-2.5-flash'],
    provider: 'google-genai',
    kind: 'text',
    billing: 'tokens',
    tiers: [{ inputPer1M: 0.3, cachedInputPer1M: 0.03, outputPer1M: 2.5 }],
  },
];

/**
 * Pick the pricing tier in effect at `at` for an entry.
 * Tiers without `effectiveFrom` are the base tier (always in effect).
 */
function selectTier(tiers: PricingTier[], at: Date): PricingTier | undefined {
  const atMs = at.getTime();
  let selected: PricingTier | undefined;
  let selectedFrom = Number.NEGATIVE_INFINITY;
  for (const tier of tiers) {
    const from = tier.effectiveFrom
      ? new Date(tier.effectiveFrom).getTime()
      : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(from) || from > atMs) continue;
    if (!selected || from >= selectedFrom) {
      selected = tier;
      selectedFrom = from;
    }
  }
  return selected;
}

/**
 * Resolve pricing for a provider/model at a point in time.
 * Returns undefined when no entry matches (caller decides on a fallback).
 */
export function resolvePricing(
  provider: string,
  model: string,
  at: Date = new Date(),
): ResolvedPricing | undefined {
  const name = model.toLowerCase();
  for (const entry of MODEL_PRICING) {
    if (entry.provider !== provider) continue;
    if (!entry.match.some((m) => name.includes(m))) continue;
    const tier = selectTier(entry.tiers, at);
    if (tier) return { entry, tier };
  }
  return undefined;
}
