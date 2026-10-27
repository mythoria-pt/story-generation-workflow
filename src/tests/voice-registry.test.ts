import { describe, expect, it } from '@jest/globals';
import {
  GEMINI_TTS_VOICES,
  OPENAI_TTS_VOICES,
  getDefaultVoiceForProvider,
  getProviderForVoice,
  isAutoVoice,
  resolveDefaultVoice,
} from '../services/voice-registry.js';
import { OPENAI_TTS_VOICES as PROVIDER_OPENAI_VOICES } from '../ai/providers/openai/tts.js';

describe('voice registry', () => {
  it('keeps the curated Gemini list exactly', () => {
    expect([...GEMINI_TTS_VOICES]).toEqual([
      'Charon',
      'Aoede',
      'Puck',
      'Kore',
      'Fenrir',
      'Orus',
      'Zephyr',
      'Sulafat',
    ]);
    expect(PROVIDER_OPENAI_VOICES).toBe(OPENAI_TTS_VOICES);
  });

  it('mirrors the webapp/admin recommended voice by audience', () => {
    const expected: Record<string, string> = {
      'children_0-2': 'Sulafat',
      'children_3-6': 'Puck',
      'children_7-10': 'Puck',
      'children_11-14': 'Puck',
      'young_adult_15-17': 'Zephyr',
      'adult_18+': 'Charon',
      all_ages: 'Sulafat',
    };
    for (const [audience, voice] of Object.entries(expected)) {
      expect(resolveDefaultVoice('google-genai', audience)).toBe(voice);
    }
    expect(resolveDefaultVoice('google-genai', 'something-new')).toBe('Sulafat');
    expect(resolveDefaultVoice('google-genai', null)).toBe('Sulafat');
    expect(resolveDefaultVoice('openai', 'children_3-6')).toBe('coral');
  });

  it('treats empty, missing and auto as auto', () => {
    expect(isAutoVoice(undefined)).toBe(true);
    expect(isAutoVoice('')).toBe(true);
    expect(isAutoVoice('  ')).toBe(true);
    expect(isAutoVoice('AUTO')).toBe(true);
    expect(isAutoVoice('Puck')).toBe(false);
  });

  it('maps voices to providers and keeps provider defaults', () => {
    expect(getProviderForVoice('sulafat')).toBe('google-genai');
    expect(getProviderForVoice('coral')).toBe('openai');
    expect(getProviderForVoice('nobody')).toBeNull();
    expect(getDefaultVoiceForProvider('google-genai')).toBe('Charon');
    expect(getDefaultVoiceForProvider('openai')).toBe('coral');
  });
});
