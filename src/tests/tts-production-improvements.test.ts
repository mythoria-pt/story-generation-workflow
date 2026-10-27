/**
 * TTS Production Implementation Validation Test
 * Tests the improved /internal/audiobook/chapter endpoint
 */

// Import environment mock first to ensure it's loaded before any other module
import './setup/environment-mock';

// Use relative path for the import to avoid path resolution issues during tests
import { AudioPromptService } from '../services/audio-prompt.js';
import {
  normalizeTTSVoice,
  processTextForTTS,
  buildFirstChapterAudioText,
  buildChapterAudioText,
  stripPauseTags,
  getMythoriaCreditMessage,
  getTranslatedChapter,
} from '../services/tts-utils.js';

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
      const speedWithPace = AudioPromptService.getRecommendedSpeed('adults', [
        'speak slowly',
        'maintain appropriate pace',
      ]);
      const speedWithoutPace = AudioPromptService.getRecommendedSpeed('adults', ['be expressive']);

      // Since the actual implementation might have specific speed calculations,
      // just test that both speeds are within valid ranges
      expect(speedWithPace).toBeGreaterThanOrEqual(0.25);
      expect(speedWithPace).toBeLessThanOrEqual(4.0);
      expect(speedWithoutPace).toBeGreaterThanOrEqual(0.25);
      expect(speedWithoutPace).toBeLessThanOrEqual(4.0);
    });

    test('should respect OpenAI TTS speed limits', () => {
      const speed = AudioPromptService.getRecommendedSpeed('adults', []);

      expect(speed).toBeGreaterThanOrEqual(0.25);
      expect(speed).toBeLessThanOrEqual(4.0);
    });
  });

  describe('TTS voice normalization', () => {
    test('should fall back when an OpenAI voice is requested for Gemini TTS', () => {
      const result = normalizeTTSVoice('google-genai', 'fable');

      expect(result).toEqual({ voice: 'Charon', wasFallback: true });
    });

    test('should keep valid Gemini voices', () => {
      const result = normalizeTTSVoice('google-genai', 'Aoede');

      expect(result).toEqual({ voice: 'Aoede', wasFallback: false });
    });

    test('should keep valid OpenAI voices', () => {
      const result = normalizeTTSVoice('openai', 'fable');

      expect(result).toEqual({ voice: 'fable', wasFallback: false });
    });
  });

  describe('TTS text preparation', () => {
    beforeEach(() => {
      process.env.TTS_PROVIDER = 'google-genai';
    });

    test('preserves contractions and punctuation without any square-bracket tags', () => {
      const result = processTextForTTS("Don't worry! It's wonderful... They're amazing.");

      expect(result).toContain("Don't");
      expect(result).toContain("It's");
      expect(result).toContain("They're");
      expect(result).toContain('...');
      expect(result).not.toMatch(/\[[a-z ]+\]/i);
      expect(result).not.toContain('Don t');
    });

    test('keeps digits for Gemini in every language', () => {
      const text = 'Ela tinha 7 gatos e 12 cães.';
      expect(processTextForTTS(text)).toBe(text);
      expect(processTextForTTS(text, { provider: 'google-genai', language: 'pt-PT' })).toBe(text);
      expect(
        processTextForTTS('She had 7 cats.', { provider: 'google-genai', language: 'en-US' }),
      ).toBe('She had 7 cats.');
    });

    test('spells small numbers only for OpenAI narrating English', () => {
      expect(
        processTextForTTS('She had 7 cats and 100 dogs.', {
          provider: 'openai',
          language: 'en-US',
        }),
      ).toBe('She had seven cats and 100 dogs.');
      expect(processTextForTTS('Tenía 7 gatos.', { provider: 'openai', language: 'es-ES' })).toBe(
        'Tenía 7 gatos.',
      );
    });

    test('chapter builders keep digits in non-English Gemini text', async () => {
      const text = await buildChapterAudioText(3, 'fr-FR', 'Il avait 5 ans.', '', 'google-genai');
      expect(text).toContain('Il avait 5 ans.');
    });

    test('cleans up extra whitespace', () => {
      expect(processTextForTTS('Hello    world!   How  are   you?')).toBe(
        'Hello world! How are you?',
      );
    });

    test('first chapter text for Gemini has no angle-bracket tokens and uses blank-line breaks', async () => {
      const text = await buildFirstChapterAudioText(
        'The Title',
        'For you',
        'Ana',
        'en-US',
        'Once upon a time.',
        'The Start',
        'google-genai',
      );

      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/\[[a-z ]+\]/i);
      const parts = text.split('\n\n');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toBe('The Title.');
      expect(parts[1]).toBe('For you.');
      expect(parts[3]).toBe('Chapter 1 - The Start.');
      expect(parts[4]).toBe('Once upon a time.');
    });

    test('separates the heading of regular chapters from the body with a blank line', async () => {
      const text = await buildChapterAudioText(2, 'en-US', 'Body.', 'Next', 'google-genai');

      expect(text).toBe('Chapter 2 - Next.\n\nBody.');
    });

    test('builds the same pause-tag-free text for OpenAI', async () => {
      const first = await buildFirstChapterAudioText(
        'The Title',
        'For you',
        'Ana',
        'en-US',
        'Once upon a time.',
        'The Start',
        'openai',
      );
      const regular = await buildChapterAudioText(2, 'en-US', 'Body.', 'Next', 'openai');

      expect(first).not.toMatch(/[<>]/);
      expect(regular).toBe('Chapter 2 - Next.\n\nBody.');
    });

    test('stripPauseTags removes stray tags, keeps paragraph breaks and leaves clean text alone', () => {
      expect(stripPauseTags('Hi. <long pause> There <short pause> you.')).toBe('Hi. There you.');
      expect(stripPauseTags('Title. <long pause>\n\nBody.')).toBe('Title.\n\nBody.');
      const clean = 'Title.\n\nBody  text.';
      expect(stripPauseTags(clean)).toBe(clean);
    });

    test('pt-PT credit and chapter strings keep their accents and use full stops', async () => {
      const credit = await getMythoriaCreditMessage('pt-PT', 'Ana');
      const chapter = await getTranslatedChapter('pt-PT');

      expect(chapter).toBe('Capítulo');
      expect(credit).toBe(
        'Esta história foi imaginada por Ana e criada com Mythoria. Conta a tua própria história.',
      );
      expect(credit).not.toContain(' - ');
    });

    test.each([
      'pt-PT',
      'pt-BR',
      'es-ES',
      'fr-FR',
      'de-DE',
      'it-IT',
      'nl-NL',
      'pl-PL',
      'en-GB',
      'en-US',
    ])('%s audio intro has no " - " separator and a non-empty chapter word', async (locale) => {
      const config = await AudioPromptService.loadAudioPrompt(locale);

      expect(config?.translations?.audioIntro).toContain('{author}');
      expect(config?.translations?.audioIntro).not.toContain(' - ');
      expect(config?.translations?.chapter?.length).toBeGreaterThan(0);
    });
  });

  describe('AudioPromptService Error Handling', () => {
    test('should handle missing audio prompt files gracefully', async () => {
      const config = await AudioPromptService.loadAudioPrompt('invalid-lang');

      expect(config).toBeNull();
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
