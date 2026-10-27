/**
 * TTS Utilities
 * Helper functions for Text-to-Speech processing and configuration
 */

import { countWords } from '@/shared/utils.js';
import { AudioPromptService } from './audio-prompt.js';
import { TTSProvider } from '@/ai/interfaces.js';
import { getDefaultVoiceForProvider, isKnownVoiceForProvider } from './voice-registry.js';
import { stripPauseTags } from '@/shared/tts-text.js';

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
  return getDefaultVoiceForProvider(provider);
}

/**
 * Normalize request-level voice overrides so voices from one provider are not
 * forwarded to another provider's API.
 */
export function normalizeTTSVoice(
  provider: TTSProvider,
  requestedVoice: string | undefined,
  fallbackVoice = getDefaultVoice(provider),
): { voice: string; wasFallback: boolean } {
  const voice = requestedVoice?.trim() || fallbackVoice;

  if (isKnownVoiceForProvider(voice, provider)) {
    return { voice, wasFallback: false };
  }

  return { voice: fallbackVoice, wasFallback: true };
}

/**
 * Get default model for a given TTS provider
 */
export function getDefaultModel(provider: TTSProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini-tts';
    case 'google-genai':
      return 'gemini-3.8-flash-tts';
    default:
      return 'gpt-4o-mini-tts';
  }
}

/**
 * Get TTS configuration from environment variables
 */
export function getTTSConfig(): TTSConfig {
  const provider = (process.env.TTS_PROVIDER || 'google-genai') as TTSProvider;
  return {
    provider,
    model: process.env.TTS_MODEL || getDefaultModel(provider),
    voice: process.env.TTS_VOICE || getDefaultVoice(provider),
    speed: parseFloat(process.env.TTS_SPEED || '1.0'),
    language: process.env.TTS_LANGUAGE || 'en-US',
  };
}

const ENGLISH_SMALL_NUMBERS = [
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

export interface ProcessTextForTTSOptions {
  provider?: TTSProvider;
  /** Story locale, e.g. 'pt-PT' */
  language?: string;
}

/**
 * Whether small numbers should be spelled out as English words.
 * Only OpenAI narrating English text benefits; Gemini reads digits natively in every
 * language, and English words would be wrong for pt/es/fr/de stories.
 */
function shouldSpellSmallNumbers(options: ProcessTextForTTSOptions): boolean {
  return options.provider === 'openai' && /^en(-|$)/i.test(options.language?.trim() ?? '');
}

/**
 * Process text to optimize for TTS pronunciation and flow.
 * Body text is passed through verbatim (no inline tags): Gemini reads the transcript as
 * written and infers prosody from punctuation. Pauses come from paragraph breaks.
 */
export function processTextForTTS(text: string, options: ProcessTextForTTSOptions = {}): string {
  let processedText = text.replace(/([.!?])\s+/g, '$1 ');

  if (shouldSpellSmallNumbers(options)) {
    processedText = processedText.replace(/\b(\d{1,2})\b/g, (match, num: string) => {
      const number = parseInt(num, 10);
      return ENGLISH_SMALL_NUMBERS[number] ?? match;
    });
  }

  return (
    processedText
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
 * Inline pause tags (`<short pause>` / `<long pause>`) are deliberately not used: Gemini can
 * read them aloud (translated), and a paragraph break already produces the same pause.
 * `stripPauseTags` is kept as a defensive sanitizer for text sent to any provider.
 */
export { stripPauseTags };

/**
 * Join the header pieces and the body with a blank line (a paragraph break is the pause).
 */
function joinWithParagraphs(parts: string[]): string {
  return parts.join('\n\n');
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
  chapterTitle?: string,
  provider: TTSProvider = getTTSConfig().provider,
): Promise<string> {
  const parts: string[] = [`${storyTitle}.`];

  // Add dedicatory message if it exists
  if (dedicatoryMessage && dedicatoryMessage.trim()) {
    parts.push(`${dedicatoryMessage.trim()}.`);
  }

  // Add the Mythoria credit message
  parts.push(await getMythoriaCreditMessage(storyLanguage, authorName));

  // Add translated "Chapter 1"
  const chapterWord = await getTranslatedChapter(storyLanguage);
  const trimmedTitle = chapterTitle?.trim();
  parts.push(trimmedTitle ? `${chapterWord} 1 - ${trimmedTitle}.` : `${chapterWord} 1.`);

  // Add the processed chapter content
  parts.push(processTextForTTS(chapterContent, { provider, language: storyLanguage }));

  return joinWithParagraphs(parts);
}

/**
 * Build regular chapter audio text
 */
export async function buildChapterAudioText(
  chapterNumber: number,
  storyLanguage: string,
  chapterContent: string,
  chapterTitle?: string,
  provider: TTSProvider = getTTSConfig().provider,
): Promise<string> {
  const chapterWord = await getTranslatedChapter(storyLanguage);
  const trimmedTitle = chapterTitle?.trim();
  const heading = trimmedTitle
    ? `${chapterWord} ${chapterNumber} - ${trimmedTitle}.`
    : `${chapterWord} ${chapterNumber}.`;

  return joinWithParagraphs([
    heading,
    processTextForTTS(chapterContent, { provider, language: storyLanguage }),
  ]);
}
