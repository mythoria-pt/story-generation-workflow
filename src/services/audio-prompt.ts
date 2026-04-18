import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/config/logger.js';
import { getPromptsPath } from '../shared/path-utils.js';

export interface AudioPromptConfig {
  systemPrompt: string;
  language: string;
  languageName: string;
  targetAgeOptions: string[];
  instructions: string[];
  translations?: {
    audioIntro?: string;
    chapter?: string;
  };
}

/**
 * Default accent enforcement prompts for languages without a config file
 * These are used as fallback when no locale-specific prompt is available
 */
const DEFAULT_ACCENT_PROMPTS: Record<string, string> = {
  'en-US':
    'You are a professional American voice actor. Speak strictly in American English with an authentic American accent.',
  'en-GB':
    'You are a professional British voice actor. Speak strictly in British English with an authentic British accent.',
  'pt-PT':
    'You are a professional Portuguese voice actor from Lisbon, Portugal. Speak strictly in European Portuguese (pt-PT). Do not use Brazilian pronunciations or vocabulary.',
  'pt-BR':
    'You are a professional Brazilian voice actor. Speak strictly in Brazilian Portuguese (pt-BR). Use authentic Brazilian pronunciation and expressions.',
  'es-ES':
    'You are a professional Spanish voice actor from Spain. Speak strictly in European Spanish (es-ES). Do not use Latin American pronunciations.',
  'fr-FR':
    'You are a professional French voice actor from France. Speak strictly in Metropolitan French (fr-FR) with an authentic Parisian accent.',
  'de-DE':
    'You are a professional German voice actor. Speak strictly in Standard German (Hochdeutsch) with an authentic German accent.',
  'it-IT':
    'You are a professional Italian voice actor. Speak strictly in Standard Italian with an authentic Italian accent.',
  'nl-NL':
    'You are a professional Dutch voice actor from the Netherlands. Speak strictly in Dutch (nl-NL) with an authentic Dutch accent.',
  'pl-PL':
    'You are a professional Polish voice actor. Speak strictly in Polish with an authentic Polish accent.',
};

export class AudioPromptService {
  private static promptCache = new Map<string, AudioPromptConfig>();

  /**
   * Load audio prompt configuration for a specific language
   */
  static async loadAudioPrompt(language: string): Promise<AudioPromptConfig | null> {
    try {
      // Check cache first
      if (this.promptCache.has(language)) {
        const cachedPrompt = this.promptCache.get(language);
        if (cachedPrompt) {
          return cachedPrompt;
        }
      }

      // Load from file
      const promptPath = join(getPromptsPath(), 'audio', `${language}.json`);
      const promptContent = await readFile(promptPath, 'utf-8');
      const promptConfig: AudioPromptConfig = JSON.parse(promptContent);

      // Cache the result
      this.promptCache.set(language, promptConfig);

      logger.info('Audio prompt loaded successfully', {
        language,
        languageName: promptConfig.languageName,
      });

      return promptConfig;
    } catch (error) {
      logger.warn('Failed to load audio prompt, falling back to default', {
        language,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Process the system prompt by replacing template variables
   */
  static processSystemPrompt(
    systemPrompt: string,
    targetAge: string | undefined,
    targetAgeOptions: string[],
  ): string {
    let processedPrompt = systemPrompt;

    // Replace {{story-target-age}} with appropriate age group
    if (targetAge && targetAgeOptions.includes(targetAge)) {
      processedPrompt = processedPrompt.replace(/\{\{story-target-age\}\}/g, targetAge);
    } else {
      // Use default (first option) if no specific target age is provided
      const defaultAge = targetAgeOptions[0] || 'general audience';
      processedPrompt = processedPrompt.replace(/\{\{story-target-age\}\}/g, defaultAge);
    }

    return processedPrompt;
  }

  /**
   * Get the complete TTS instructions for a story
   */
  static async getTTSInstructions(
    storyLanguage: string,
    targetAge?: string,
  ): Promise<{
    systemPrompt: string;
    instructions: string[];
    language: string;
    languageName: string;
  } | null> {
    const promptConfig = await this.loadAudioPrompt(storyLanguage);

    if (!promptConfig) {
      return null;
    }

    const processedSystemPrompt = this.processSystemPrompt(
      promptConfig.systemPrompt,
      targetAge,
      promptConfig.targetAgeOptions,
    );

    return {
      systemPrompt: processedSystemPrompt,
      instructions: promptConfig.instructions,
      language: promptConfig.language,
      languageName: promptConfig.languageName,
    };
  }

  /**
   * Get recommended voice for OpenAI TTS based on system prompt and language
   */
  static getRecommendedVoice(
    systemPrompt: string,
    _language: string,
    targetAge?: string,
  ): 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' {
    // Voice selection based on target audience and language
    const lowerPrompt = systemPrompt.toLowerCase();

    // For children's content, use warmer, more expressive voices
    if (targetAge === 'toddlers' || targetAge === 'children') {
      if (lowerPrompt.includes('fun') || lowerPrompt.includes('funny')) {
        return 'nova'; // Expressive and warm
      }
      return 'alloy'; // Clear and friendly
    }

    // For storytelling that emphasizes emotion and passion
    if (lowerPrompt.includes('passion') || lowerPrompt.includes('emotion')) {
      return 'fable'; // Expressive storytelling voice
    }

    // For professional or adult content
    if (targetAge === 'adults' || targetAge === 'young adults') {
      return 'onyx'; // Deep and authoritative
    }

    // Default to nova for general storytelling
    return 'nova';
  }

  /**
   * Get recommended speed based on target age and instructions
   */
  static getRecommendedSpeed(targetAge: string | undefined, instructions: string[]): number {
    // Default speed from environment or 1.0
    let speed = parseFloat(process.env.TTS_SPEED || '1.0');

    // Adjust speed based on target age
    if (targetAge === 'toddlers') {
      speed = Math.min(speed * 0.8, 0.9); // Slower for toddlers
    } else if (targetAge === 'children') {
      speed = Math.min(speed * 0.9, 1.0); // Slightly slower for children
    } else if (targetAge === 'adults') {
      speed = Math.max(speed * 1.1, 1.2); // Can be faster for adults
    }

    // Check instructions for pace guidance
    const instructionText = instructions.join(' ').toLowerCase();
    if (instructionText.includes('slow') || instructionText.includes('pace')) {
      speed *= 1;
    }

    // Ensure speed is withinlimits (0.25 to 4.0)
    return Math.max(0.9, Math.min(1.2, speed));
  }

  /**
   * Process text for better TTS pronunciation and pacing
   */
  static enhanceTextForTTS(
    originalText: string,
    systemPrompt: string,
    instructions: string[],
  ): string {
    // Don't prepend system prompts to text - they should not be read aloud
    // Instead, enhance the text based on the instructions for better TTS

    let enhancedText = originalText;

    // Apply text processing based on instructions
    const instructionText = instructions.join(' ').toLowerCase();

    // Add appropriate pauses for emotional delivery
    if (
      systemPrompt.toLowerCase().includes('emotion') ||
      systemPrompt.toLowerCase().includes('passion')
    ) {
      // Add slight pauses after emotional moments
      enhancedText = enhancedText
        .replace(/(!|\.\.\.)/g, '$1 ') // Pause after exclamations and ellipses
        .replace(/([.!?])\s*"/g, '$1" '); // Pause after quoted speech
    }

    // Enhance pronunciation for clear articulation
    if (instructionText.includes('clear') || instructionText.includes('pronounce')) {
      // Add pronunciation hints for difficult words
      enhancedText = enhancedText
        .replace(/\b(said|says)\b/g, 'said') // Ensure clear past tense
        .replace(/(\w+)'(\w+)/g, '$1 $2'); // Separate contractions slightly
    }

    // Clean up any extra whitespace
    enhancedText = enhancedText.replace(/\s+/g, ' ').trim();

    return enhancedText;
  }

  /**
   * Clear the prompt cache (useful for testing or dynamic reloading)
   */
  static clearCache(): void {
    this.promptCache.clear();
  }

  /**
   * Get the TTS system prompt for accent enforcement
   * This prompt is sent as a system instruction to the TTS API to ensure
   * consistent accent and pronunciation for the target language.
   *
   * @param storyLanguage - The language code (e.g., 'pt-PT', 'en-US')
   * @param targetAge - Optional target age for audience-specific adjustments
   * @returns The system prompt string for the TTS API
   */
  static async getTTSSystemPrompt(storyLanguage: string, targetAge?: string): Promise<string> {
    // Try to load the full audio prompt config
    const promptConfig = await this.loadAudioPrompt(storyLanguage);

    if (promptConfig) {
      // Process the system prompt with target age
      const processedPrompt = this.processSystemPrompt(
        promptConfig.systemPrompt,
        targetAge,
        promptConfig.targetAgeOptions,
      );

      logger.info('Using locale-specific TTS system prompt', {
        language: storyLanguage,
        languageName: promptConfig.languageName,
        targetAge,
        promptLength: processedPrompt.length,
      });

      return processedPrompt;
    }

    // Fallback to default accent enforcement prompts
    const defaultPrompt = DEFAULT_ACCENT_PROMPTS[storyLanguage];
    if (defaultPrompt) {
      logger.info('Using default accent enforcement prompt', {
        language: storyLanguage,
      });
      return defaultPrompt;
    }

    // Ultimate fallback for unknown languages
    logger.warn('No accent enforcement prompt available, using generic fallback', {
      language: storyLanguage,
    });
    return `You are a professional voice actor. Speak clearly and naturally in ${storyLanguage}.`;
  }

  /**
   * Get translated "Chapter" word for the given language
   */
  static async getTranslatedChapter(storyLanguage: string): Promise<string> {
    const promptConfig = await this.loadAudioPrompt(storyLanguage);

    if (promptConfig?.translations?.chapter) {
      return promptConfig.translations.chapter;
    }

    // Fallback to default English
    return 'Chapter';
  }

  /**
   * Get translated audio intro message for the given language
   */
  static async getTranslatedAudioIntro(storyLanguage: string, authorName: string): Promise<string> {
    const promptConfig = await this.loadAudioPrompt(storyLanguage);

    if (promptConfig?.translations?.audioIntro) {
      return promptConfig.translations.audioIntro.replace('{author}', authorName);
    }

    // Fallback to default English
    return `This story was imagined by ${authorName} and crafted using Mythoria - tell your own story.`;
  }
}
