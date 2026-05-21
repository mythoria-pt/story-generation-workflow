/**
 * Voice Registry
 * Maps voice names to their respective TTS providers
 */

import { TTSProvider } from '@/ai/interfaces.js';

export interface VoiceMetadata {
  name: string;
  provider: TTSProvider;
  isDefault?: boolean;
}

/**
 * OpenAI TTS voices
 */
export const OPENAI_VOICES: VoiceMetadata[] = [
  { name: 'alloy', provider: 'openai' },
  { name: 'ash', provider: 'openai' },
  { name: 'ballad', provider: 'openai' },
  { name: 'coral', provider: 'openai', isDefault: true },
  { name: 'echo', provider: 'openai' },
  { name: 'fable', provider: 'openai' },
  { name: 'nova', provider: 'openai' },
  { name: 'onyx', provider: 'openai' },
  { name: 'sage', provider: 'openai' },
  { name: 'shimmer', provider: 'openai' },
  { name: 'verse', provider: 'openai' },
];

/**
 * Google Gemini TTS voices
 */
export const GEMINI_VOICES: VoiceMetadata[] = [
  { name: 'Charon', provider: 'google-genai', isDefault: true },
  { name: 'Aoede', provider: 'google-genai' },
  { name: 'Puck', provider: 'google-genai' },
  { name: 'Kore', provider: 'google-genai' },
  { name: 'Fenrir', provider: 'google-genai' },
  { name: 'Orus', provider: 'google-genai' },
  { name: 'Zephyr', provider: 'google-genai' },
  { name: 'Sulafat', provider: 'google-genai' },
];

const ALL_VOICES = [...OPENAI_VOICES, ...GEMINI_VOICES];

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
 * Get the default voice for a provider
 */
export function getDefaultVoiceForProvider(provider: TTSProvider): string {
  const found = ALL_VOICES.find((v) => v.provider === provider && v.isDefault);
  return found ? found.name : (provider === 'google-genai' ? 'Charon' : 'coral');
}
