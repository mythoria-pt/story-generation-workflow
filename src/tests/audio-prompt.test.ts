import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the logger to avoid dependency issues in tests
jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { AudioPromptService } from '../services/audio-prompt';

describe('AudioPromptService', () => {
  beforeEach(() => {
    // Clear cache before each test
    AudioPromptService.clearCache();
  });

  it('should load English (US) audio prompt configuration', async () => {
    const config = await AudioPromptService.loadAudioPrompt('en-US');

    expect(config).not.toBeNull();
    expect(config?.language).toBe('en-US');
    expect(config?.languageName).toBe('English (American)');
    expect(config?.systemPrompt).toContain('professional American storyteller');
    expect(config?.targetAgeOptions).toContain('children');
    expect(config?.instructions).toHaveLength(5);
  });

  it('should load Portuguese (Portugal) audio prompt configuration', async () => {
    const config = await AudioPromptService.loadAudioPrompt('pt-PT');

    expect(config).not.toBeNull();
    expect(config?.language).toBe('pt-PT');
    expect(config?.languageName).toBe('Portuguese (Portugal)');
    expect(config?.systemPrompt).toContain('narradora Portuguesa');
    expect(config?.targetAgeOptions).toContain('crianças');
  });

  it('should return null for non-existent language', async () => {
    const config = await AudioPromptService.loadAudioPrompt('xx-XX');

    expect(config).toBeNull();
  });

  it('should process system prompt with target age replacement', async () => {
    const systemPrompt = 'You are a storyteller for {{story-target-age}}.';
    const targetAgeOptions = ['children', 'adults'];

    const processed = AudioPromptService.processSystemPrompt(
      systemPrompt,
      'children',
      targetAgeOptions,
    );

    expect(processed).toBe('You are a storyteller for children.');
  });

  it('should use default target age when none specified', async () => {
    const systemPrompt = 'You are a storyteller for {{story-target-age}}.';
    const targetAgeOptions = ['children', 'adults'];

    const processed = AudioPromptService.processSystemPrompt(
      systemPrompt,
      undefined,
      targetAgeOptions,
    );

    expect(processed).toBe('You are a storyteller for children.');
  });

  it('should get complete TTS instructions', async () => {
    const instructions = await AudioPromptService.getTTSInstructions('en-US');

    expect(instructions).not.toBeNull();
    expect(instructions?.systemPrompt).toContain('professional American storyteller');
    expect(instructions?.instructions).toHaveLength(5);
    expect(instructions?.language).toBe('en-US');
    expect(instructions?.languageName).toBe('English (American)');
  });
  it('should enhance text for TTS without including system prompts', async () => {
    const originalText = 'Once upon a time, there was a brave knight.';
    const systemPrompt = 'You are a professional storyteller.';
    const instructions = ['Speak clearly', 'Use emotions'];

    const enhanced = AudioPromptService.enhanceTextForTTS(originalText, systemPrompt, instructions);

    // The enhanced text should NOT contain system prompts (they shouldn't be read aloud)
    expect(enhanced).not.toContain('You are a professional storyteller.');
    // The enhanced text should still contain the original content
    expect(enhanced).toContain(originalText);
    // Text should be cleaned and processed for better TTS
    expect(enhanced).toBe(originalText); // For this simple case, it should be the same after cleaning
  });

  it('should cache prompt configurations', async () => {
    // First load
    const config1 = await AudioPromptService.loadAudioPrompt('en-US');

    // Second load (should be from cache)
    const config2 = await AudioPromptService.loadAudioPrompt('en-US');

    expect(config1).toBe(config2); // Same object reference indicates caching
  });
});
