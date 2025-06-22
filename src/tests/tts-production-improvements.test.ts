/**
 * TTS Production Implementation Validation Test
 * Tests the improved /internal/audiobook/chapter endpoint
 */

import { AudioPromptService } from '@/services/audio-prompt.js';

describe('TTS Production Improvements', () => {
  beforeEach(() => {
    // Clear any cached prompts
    AudioPromptService.clearCache();
  });

  describe('AudioPromptService Voice Recommendations', () => {
    test('should recommend appropriate voice for children content', () => {
      const systemPrompt = 'You are a fun and funny storyteller for children';
      const voice = AudioPromptService.getRecommendedVoice(systemPrompt, 'en-US', 'children');
      
      expect(['alloy', 'nova']).toContain(voice);
    });

    test('should recommend fable for emotional content', () => {
      const systemPrompt = 'You speak passionately and with a lot of emotion';
      const voice = AudioPromptService.getRecommendedVoice(systemPrompt, 'en-US');
      
      expect(voice).toBe('fable');
    });

    test('should recommend onyx for adult content', () => {
      const systemPrompt = 'You are a professional storyteller';
      const voice = AudioPromptService.getRecommendedVoice(systemPrompt, 'en-US', 'adults');
      
      expect(voice).toBe('onyx');
    });

    test('should default to nova for general storytelling', () => {
      const systemPrompt = 'You are a storyteller';
      const voice = AudioPromptService.getRecommendedVoice(systemPrompt, 'en-US');
      
      expect(voice).toBe('nova');
    });
  });

  describe('AudioPromptService Speed Recommendations', () => {
    test('should recommend slower speed for toddlers', () => {
      const speed = AudioPromptService.getRecommendedSpeed('toddlers', []);
      
      expect(speed).toBeLessThanOrEqual(1.0);
      expect(speed).toBeGreaterThanOrEqual(0.25);
    });

    test('should recommend faster speed for adults', () => {
      const baseSpeed = parseFloat(process.env.TTS_SPEED || '1.0');
      const speed = AudioPromptService.getRecommendedSpeed('adults', []);
      
      expect(speed).toBeGreaterThanOrEqual(baseSpeed);
      expect(speed).toBeLessThanOrEqual(4.0);
    });

    test('should adjust speed based on pace instructions', () => {
      const speedWithPace = AudioPromptService.getRecommendedSpeed('adults', ['speak slowly', 'maintain appropriate pace']);
      const speedWithoutPace = AudioPromptService.getRecommendedSpeed('adults', ['be expressive']);
      
      expect(speedWithPace).toBeLessThan(speedWithoutPace);
    });

    test('should respect OpenAI TTS speed limits', () => {
      const speed = AudioPromptService.getRecommendedSpeed('adults', []);
      
      expect(speed).toBeGreaterThanOrEqual(0.25);
      expect(speed).toBeLessThanOrEqual(4.0);
    });
  });

  describe('AudioPromptService Text Enhancement', () => {
    test('should enhance text without including system prompts', () => {
      const originalText = 'Hello! she said excitedly. "How are you?"';
      const systemPrompt = 'You are a passionate storyteller';
      const instructions = ['Use proper punctuation'];
      
      const enhanced = AudioPromptService.enhanceTextForTTS(originalText, systemPrompt, instructions);
      
      // Should not include system prompt in the text
      expect(enhanced).not.toContain('You are a passionate storyteller');
      
      // Should contain the original text
      expect(enhanced).toContain('Hello!');
      expect(enhanced).toContain('How are you?');
    });

    test('should add pauses for emotional content', () => {
      const originalText = 'Amazing! That was incredible...';
      const systemPrompt = 'You speak with emotion and passion';
      const instructions = [];
      
      const enhanced = AudioPromptService.enhanceTextForTTS(originalText, systemPrompt, instructions);
      
      // Should have enhanced spacing for pauses
      expect(enhanced).toContain('Amazing! ');
      expect(enhanced).toContain('incredible... ');
    });

    test('should improve pronunciation for clear articulation', () => {
      const originalText = "It's wonderful! They're amazing.";
      const systemPrompt = 'You are a storyteller';
      const instructions = ['Pronounce all words clearly'];
      
      const enhanced = AudioPromptService.enhanceTextForTTS(originalText, systemPrompt, instructions);
      
      // Should separate contractions for better pronunciation
      expect(enhanced).toContain('It s wonderful');
      expect(enhanced).toContain('They re amazing');
    });

    test('should clean up extra whitespace', () => {
      const originalText = 'Hello    world!   How  are   you?';
      const systemPrompt = 'You are a storyteller';
      const instructions = [];
      
      const enhanced = AudioPromptService.enhanceTextForTTS(originalText, systemPrompt, instructions);
      
      expect(enhanced).toBe('Hello world! How are you?');
    });
  });

  describe('AudioPromptService Error Handling', () => {
    test('should handle missing audio prompt files gracefully', async () => {
      const instructions = await AudioPromptService.getTTSInstructions('invalid-lang');
      
      expect(instructions).toBeNull();
    });

    test('should provide fallback voice when prompt loading fails', () => {
      const voice = AudioPromptService.getRecommendedVoice('', 'invalid-lang');
      
      expect(voice).toBe('nova'); // Default fallback
    });

    test('should provide valid speed when no target age is specified', () => {
      const speed = AudioPromptService.getRecommendedSpeed(undefined, []);
      
      expect(speed).toBeGreaterThanOrEqual(0.25);
      expect(speed).toBeLessThanOrEqual(4.0);
    });
  });
});
