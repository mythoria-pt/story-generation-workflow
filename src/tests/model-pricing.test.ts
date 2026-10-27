import { describe, it, expect } from '@jest/globals';
import { MODEL_PRICING, USD_TO_EUR, resolvePricing } from '../services/model-pricing';

describe('model-pricing', () => {
  it('exports the USD to EUR rate', () => {
    expect(USD_TO_EUR).toBe(0.92);
  });

  it('matches by substring and provider', () => {
    expect(resolvePricing('google-genai', 'gemini-3.8-flash-preview')?.tier.inputPer1M).toBe(0.75);
    expect(resolvePricing('openai', 'gemini-3.8-flash')).toBeUndefined();
    expect(resolvePricing('google-genai', 'does-not-exist')).toBeUndefined();
  });

  it('prefers the more specific entry (flash-lite before flash)', () => {
    expect(resolvePricing('google-genai', 'gemini-3.5-flash-lite')?.tier.inputPer1M).toBe(0.3);
    expect(resolvePricing('google-genai', 'gemini-3.5-flash')?.tier.inputPer1M).toBe(1.5);
    expect(resolvePricing('openai', 'gpt-5.5-pro')?.tier.inputPer1M).toBe(30);
    expect(resolvePricing('openai', 'gpt-5.4-mini')?.tier.inputPer1M).toBe(0.75);
  });

  it('selects the latest tier whose effectiveFrom is on or before the date', () => {
    const before = resolvePricing(
      'google-genai',
      'gemini-4-argon',
      new Date('2026-11-30T23:59:59Z'),
    );
    const on = resolvePricing('google-genai', 'gemini-4-argon', new Date('2026-12-01T00:00:00Z'));
    expect(before?.tier.outputPer1M).toBe(10);
    expect(on?.tier.outputPer1M).toBe(20);
  });

  it('resolves both luna aliases to the same entry', () => {
    expect(resolvePricing('openai', 'gpt-6-luna')?.entry).toBe(
      resolvePricing('openai', 'gpt-6.1-luna')?.entry,
    );
  });

  it('has a base tier for every entry', () => {
    for (const entry of MODEL_PRICING) {
      expect(entry.tiers.some((t) => !t.effectiveFrom)).toBe(true);
    }
  });

  describe('Google TTS entries', () => {
    it('resolves gemini-3.8-flash-tts to TTS rates, not gemini-3.8-flash text rates', () => {
      const resolved = resolvePricing(
        'google-genai',
        'gemini-3.8-flash-tts',
        new Date('2026-11-01'),
      );
      expect(resolved?.entry.kind).toBe('tts');
      expect(resolved?.tier.inputPer1M).toBe(0.5);
      expect(resolved?.tier.outputPer1M).toBe(9);
      expect(resolvePricing('google-genai', 'gemini-3.8-flash')?.entry.kind).toBe('text');
    });

    it('switches to the 2027 rates on 2027-01-01', () => {
      const before = resolvePricing(
        'google-genai',
        'gemini-3.8-flash-tts',
        new Date('2026-12-31T23:59:59Z'),
      );
      const after = resolvePricing(
        'google-genai',
        'gemini-3.8-flash-tts',
        new Date('2027-01-01T00:00:00Z'),
      );
      expect(before?.tier.outputPer1M).toBe(9);
      expect(after?.tier.inputPer1M).toBe(1);
      expect(after?.tier.outputPer1M).toBe(18);
    });

    it('never resolves any Google *-tts model to a non-TTS entry', () => {
      for (const model of [
        'gemini-3.8-flash-tts',
        'gemini-2.5-pro-preview-tts',
        'gemini-2.5-flash-preview-tts',
      ]) {
        expect(resolvePricing('google-genai', model)?.entry.kind).toBe('tts');
      }
    });
  });
});
