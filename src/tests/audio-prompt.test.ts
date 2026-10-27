import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the logger to avoid dependency issues in tests
jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { AudioPromptService, AUDIO_TARGET_AGES } from '../services/audio-prompt';

describe('AudioPromptService', () => {
  beforeEach(() => {
    AudioPromptService.clearCache();
  });

  it('should load English (US) audio prompt configuration', async () => {
    const config = await AudioPromptService.loadAudioPrompt('en-US');

    expect(config).not.toBeNull();
    expect(config?.language).toBe('en-US');
    expect(config?.languageName).toBe('English (American)');
    expect(Object.keys(config?.baseStyle ?? {})).toEqual([...AUDIO_TARGET_AGES]);
    expect(config?.translations?.chapter).toBe('Chapter');
  });

  it('should load Portuguese (Portugal) audio prompt configuration', async () => {
    const config = await AudioPromptService.loadAudioPrompt('pt-PT');

    expect(config).not.toBeNull();
    expect(config?.language).toBe('pt-PT');
    expect(config?.languageName).toBe('Portuguese (Portugal)');
    expect(config?.baseStyle?.children).toBeTruthy();
  });

  it('should return null for non-existent language', async () => {
    expect(await AudioPromptService.loadAudioPrompt('xx-XX')).toBeNull();
  });

  it('keeps base styles to one short line without accent or voice-consistency wording', async () => {
    for (const locale of ['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE']) {
      const config = await AudioPromptService.loadAudioPrompt(locale);
      for (const style of Object.values(config?.baseStyle ?? {})) {
        expect(style).not.toContain('\n');
        expect(style.length).toBeLessThan(100);
        expect(style.toLowerCase()).not.toMatch(/accent|consistent|\bage\b|male|female/);
      }
    }
  });

  describe('getBaseStyle', () => {
    it('returns the style for a known target age', async () => {
      expect(await AudioPromptService.getBaseStyle('en-US', 'toddlers')).toContain('sing-song');
      expect(await AudioPromptService.getBaseStyle('pt-PT', 'adults')).toContain('immersive');
    });

    it('maps general audience and all_ages to the general audience style', async () => {
      const general = await AudioPromptService.getBaseStyle('en-US', 'general audience');
      expect(general).toContain('Warm, engaging storyteller');
      expect(await AudioPromptService.getBaseStyle('en-US', 'all_ages')).toBe(general);
    });

    it('does not fall back to toddlers when the age is missing or unknown', async () => {
      const general = await AudioPromptService.getBaseStyle('en-US', 'general audience');
      expect(await AudioPromptService.getBaseStyle('en-US', undefined)).toBe(general);
      expect(await AudioPromptService.getBaseStyle('en-US', 'martians')).toBe(general);
    });

    it('falls back to en-US for locales without a file', async () => {
      const en = await AudioPromptService.getBaseStyle('en-US', 'children');
      expect(await AudioPromptService.getBaseStyle('xx-XX', 'children')).toBe(en);
    });
  });

  it('builds an OpenAI instruction string from accent hint plus base style', async () => {
    const prompt = await AudioPromptService.getTTSSystemPrompt('pt-PT', 'children');

    expect(prompt).toContain('European Portuguese');
    expect(prompt).toContain('Delivery style: Warm, playful storyteller');
  });

  it('should cache prompt configurations', async () => {
    const config1 = await AudioPromptService.loadAudioPrompt('en-US');
    const config2 = await AudioPromptService.loadAudioPrompt('en-US');

    expect(config1).toBe(config2);
  });
});
