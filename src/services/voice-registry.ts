/**
 * Voice Registry
 * Single source of truth for the TTS voice lists, voice-to-provider mapping and the
 * per-audience default voice. Providers and TTS utilities import from here.
 */

import { TTSProvider } from '@/ai/interfaces.js';

export interface VoiceMetadata {
  name: string;
  provider: TTSProvider;
  isDefault?: boolean;
}

/**
 * Curated Google Gemini TTS voices for storytelling (prebuilt voices).
 */
export const GEMINI_TTS_VOICES = [
  'Charon', // Informative - good for narration (provider default)
  'Aoede', // Breezy - light and pleasant
  'Puck', // Upbeat - energetic delivery
  'Kore', // Firm - confident and clear
  'Fenrir', // Excitable - dynamic storytelling
  'Orus', // Firm - authoritative
  'Zephyr', // Bright - cheerful tone
  'Sulafat', // Warm - comfortable and inviting
] as const;

export type GeminiTTSVoice = (typeof GEMINI_TTS_VOICES)[number];

/**
 * OpenAI TTS voices.
 */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

export type OpenAITTSVoice = (typeof OPENAI_TTS_VOICES)[number];

const GEMINI_PROVIDER_DEFAULT: GeminiTTSVoice = 'Charon';
const OPENAI_PROVIDER_DEFAULT: OpenAITTSVoice = 'coral';

export const OPENAI_VOICES: VoiceMetadata[] = OPENAI_TTS_VOICES.map((name) => ({
  name,
  provider: 'openai' as const,
  ...(name === OPENAI_PROVIDER_DEFAULT ? { isDefault: true } : {}),
}));

export const GEMINI_VOICES: VoiceMetadata[] = GEMINI_TTS_VOICES.map((name) => ({
  name,
  provider: 'google-genai' as const,
  ...(name === GEMINI_PROVIDER_DEFAULT ? { isDefault: true } : {}),
}));

const ALL_VOICES = [...OPENAI_VOICES, ...GEMINI_VOICES];

/**
 * Recommended Gemini voice per story target audience.
 * Mirrors `GEMINI_RECOMMENDED_VOICE_BY_AUDIENCE` in `mythoria-webapp/src/lib/voice-options.ts`
 * and the admin mapping in `mythoria_admin/src/lib/voice-options.ts`. Keep all three in sync.
 */
export const GEMINI_RECOMMENDED_VOICE_BY_AUDIENCE: Readonly<Record<string, GeminiTTSVoice>> = {
  'children_0-2': 'Sulafat',
  'children_3-6': 'Puck',
  'children_7-10': 'Puck',
  'children_11-14': 'Puck',
  'young_adult_15-17': 'Zephyr',
  'adult_18+': 'Charon',
  all_ages: 'Sulafat',
};

const GEMINI_AUDIENCE_FALLBACK_VOICE: GeminiTTSVoice = 'Sulafat';

/** Sentinel a client sends to let SGW pick the voice. */
export const AUTO_VOICE = 'auto';

/**
 * True when the requested voice is missing, blank or the 'auto' sentinel.
 */
export function isAutoVoice(voice: string | null | undefined): boolean {
  const trimmed = typeof voice === 'string' ? voice.trim() : '';
  return trimmed === '' || trimmed.toLowerCase() === AUTO_VOICE;
}

/**
 * Default voice for a story audience. OpenAI always uses 'coral'; Gemini follows the
 * recommended-by-audience table, with unknown audiences resolving to Sulafat.
 */
export function resolveDefaultVoice(
  provider: TTSProvider,
  targetAudience: string | null | undefined,
): string {
  if (provider === 'openai') return OPENAI_PROVIDER_DEFAULT;
  const key = targetAudience?.trim() ?? '';
  return GEMINI_RECOMMENDED_VOICE_BY_AUDIENCE[key] ?? GEMINI_AUDIENCE_FALLBACK_VOICE;
}

/**
 * Whether the voice name belongs to the provider's curated list (exact, case-sensitive).
 */
export function isKnownVoiceForProvider(voice: string, provider: TTSProvider): boolean {
  const list: readonly string[] =
    provider === 'google-genai' ? GEMINI_TTS_VOICES : OPENAI_TTS_VOICES;
  return list.includes(voice);
}

/**
 * Get the provider for a given voice name
 */
export function getProviderForVoice(voice: string): TTSProvider | null {
  const normalizedVoice = voice.toLowerCase();
  const found = ALL_VOICES.find((v) => v.name.toLowerCase() === normalizedVoice);
  return found ? found.provider : null;
}

/**
 * Check if a voice is valid for a given provider
 */
export function isValidVoiceForProvider(voice: string, provider: TTSProvider): boolean {
  const normalizedVoice = voice.toLowerCase();
  return ALL_VOICES.some(
    (v) => v.name.toLowerCase() === normalizedVoice && v.provider === provider,
  );
}

/**
 * Get the provider-level default voice (used when no story audience is available).
 */
export function getDefaultVoiceForProvider(provider: TTSProvider): string {
  return provider === 'google-genai' ? GEMINI_PROVIDER_DEFAULT : OPENAI_PROVIDER_DEFAULT;
}
