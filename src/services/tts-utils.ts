/**
 * TTS Utilities
 * Helper functions for Text-to-Speech processing and configuration
 */

import { countWords } from '@/shared/utils.js';
import { AudioPromptService } from './audio-prompt.js';
import { TTSProvider } from '@/ai/interfaces.js';

export interface TTSConfig {
  provider: TTSProvider;
  model: string;
  voice: string;
  speed: number;
  language: string;
}

/**
 * Get default voice for a given TTS provider
 */
export function getDefaultVoice(provider: TTSProvider): string {
  switch (provider) {
    case 'openai':
      return 'coral';
    case 'google-genai':
      return 'Charon';
    default:
      return 'coral';
  }
}

/**
 * Get default model for a given TTS provider
 */
export function getDefaultModel(provider: TTSProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini-tts';
    case 'google-genai':
      return 'gemini-2.5-pro-preview-tts';
    default:
      return 'gpt-4o-mini-tts';
  }
}

/**
 * Get TTS configuration from environment variables
 */
export function getTTSConfig(): TTSConfig {
  const provider = (process.env.TTS_PROVIDER || 'openai') as TTSProvider;
  return {
    provider,
    model: process.env.TTS_MODEL || getDefaultModel(provider),
    voice: process.env.TTS_VOICE || getDefaultVoice(provider),
    speed: parseFloat(process.env.TTS_SPEED || '1.0'),
    language: process.env.TTS_LANGUAGE || 'en-US',
  };
}

/**
 * Process text to optimize for TTS pronunciation and flow
 */
export function processTextForTTS(text: string): string {
  // Apply TTS best practices
  return (
    text
      // Add natural pauses with commas for better breathing
      .replace(/([.!?])\s+/g, '$1 ')
      // Handle numbers - spell out small numbers
      .replace(/\b(\d{1,2})\b/g, (match, num) => {
        const number = parseInt(num);
        const words = [
          'zero',
          'one',
          'two',
          'three',
          'four',
          'five',
          'six',
          'seven',
          'eight',
          'nine',
          'ten',
          'eleven',
          'twelve',
          'thirteen',
          'fourteen',
          'fifteen',
          'sixteen',
          'seventeen',
          'eighteen',
          'nineteen',
          'twenty',
        ];
        return number <= 20 && words[number] ? words[number] : match;
      })
      // Add pauses for dramatic effect
      .replace(/\.\.\./g, '... ')
      // Ensure proper punctuation for pauses
      .replace(/([,;:])\s*/g, '$1 ')
      // Clean up extra spaces
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Estimate audio duration based on text length
 */
export function estimateDuration(text: string): number {
  // Rough estimation: average speaking rate is ~150 words per minute
  const wordCount = countWords(text);
  const wordsPerMinute = 140;
  return Math.ceil((wordCount / wordsPerMinute) * 60); // return seconds
}

/**
 * Get maximum chunk size (in characters) for a given TTS provider
 * Each provider has different limits for text input per request
 */
export function getMaxChunkSize(provider?: TTSProvider): number {
  const effectiveProvider = provider || getTTSConfig().provider;
  switch (effectiveProvider) {
    case 'openai':
      // OpenAI TTS has a 4096 character limit per request
      return 4096;
    case 'google-genai':
      // Gemini TTS supports longer text - using conservative 8000 char limit
      // Actual limit may be higher but this provides safe margin
      return 8000;
    default:
      return 4096;
  }
}

/**
 * Get audio filename for a chapter
 */
export function getAudioFilename(storyId: string, chapterNumber: number): string {
  // Ensure chapter numbers are zero-padded (chapter_01.mp3, chapter_02.mp3, etc.)
  const paddedNumber = chapterNumber.toString().padStart(2, '0');
  return `${storyId}/audio/chapter_${paddedNumber}.mp3`;
}

/**
 * Get translated "Chapter" word for the given language
 */
export async function getTranslatedChapter(storyLanguage: string): Promise<string> {
  return await AudioPromptService.getTranslatedChapter(storyLanguage);
}

/**
 * Get translated audio intro message for the given language
 */
export async function getTranslatedAudioIntro(
  storyLanguage: string,
  authorName: string,
): Promise<string> {
  return await AudioPromptService.getTranslatedAudioIntro(storyLanguage, authorName);
}

/**
 * Get Mythoria credit message in the story language
 */
export async function getMythoriaCreditMessage(
  storyLanguage: string,
  authorName: string,
): Promise<string> {
  // First try to get from AudioPromptService which uses the proper translation files
  try {
    const creditMessage = await AudioPromptService.getTranslatedAudioIntro(
      storyLanguage,
      authorName,
    );
    if (creditMessage && !creditMessage.includes('This story was imagined')) {
      // If we got a non-default translation, use it
      return creditMessage;
    }
  } catch {
    // Fallback to hardcoded translations if AudioPromptService fails
  }

  // Fallback to hardcoded translations (including pt-PT)
  const translations: Record<string, string> = {
    'en-US': `This story was imagined by ${authorName} and crafted by Mythoria. Tell your own story.`,
    'es-ES': `Esta historia fue imaginada por ${authorName} y creada por Mythoria. Cuenta tu propia historia.`,
    'fr-FR': `Cette histoire a été imaginée par ${authorName} et créée par Mythoria. Racontez votre propre histoire.`,
    'de-DE': `Diese Geschichte wurde von ${authorName} erdacht und von Mythoria erstellt. Erzähle deine eigene Geschichte.`,
    'it-IT': `Questa storia è stata immaginata da ${authorName} e creata da Mythoria. Racconta la tua storia.`,
    'pt-BR': `Esta história foi imaginada por ${authorName} e criada por Mythoria. Conte sua própria história.`,
    'pt-PT': `Esta história foi imaginada por ${authorName} e criada por Mythoria. Conte a sua própria história.`,
    // Add more languages as needed
  };

  return (
    translations[storyLanguage] ||
    translations['en-US'] ||
    `This story was imagined by ${authorName} and crafted by Mythoria. Tell your own story.`
  );
}

/**
 * Build the complete first chapter audio text with story intro
 */
export async function buildFirstChapterAudioText(
  storyTitle: string,
  dedicatoryMessage: string | null,
  authorName: string,
  storyLanguage: string,
  chapterContent: string,
): Promise<string> {
  let text = storyTitle + '.';

  // Add dedicatory message if it exists
  if (dedicatoryMessage && dedicatoryMessage.trim()) {
    text += ` ${dedicatoryMessage.trim()}.`;
  }

  // Add the Mythoria credit message
  const creditMessage = await getMythoriaCreditMessage(storyLanguage, authorName);
  text += ` ${creditMessage}`;

  // Add translated "Chapter 1"
  const chapterWord = await getTranslatedChapter(storyLanguage);
  text += ` ${chapterWord} 1.`;

  // Add the processed chapter content
  text += ` ${processTextForTTS(chapterContent)}`;

  return text;
}

/**
 * Build regular chapter audio text
 */
export async function buildChapterAudioText(
  chapterNumber: number,
  storyLanguage: string,
  chapterContent: string,
): Promise<string> {
  const chapterWord = await getTranslatedChapter(storyLanguage);
  let text = `${chapterWord} ${chapterNumber}.`;

  // Add the processed chapter content
  text += ` ${processTextForTTS(chapterContent)}`;

  return text;
}
