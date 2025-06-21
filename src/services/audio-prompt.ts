import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/config/logger.js';

export interface AudioPromptConfig {
  systemPrompt: string;
  language: string;
  languageName: string;
  targetAgeOptions: string[];
  instructions: string[];
}

export class AudioPromptService {
  private static promptCache = new Map<string, AudioPromptConfig>();

  /**
   * Load audio prompt configuration for a specific language
   */
  static async loadAudioPrompt(language: string): Promise<AudioPromptConfig | null> {
    try {
      // Check cache first
      if (this.promptCache.has(language)) {
        return this.promptCache.get(language)!;
      }

      // Load from file
      const promptPath = join(process.cwd(), 'src', 'prompts', 'audio', `${language}.json`);
      const promptContent = await readFile(promptPath, 'utf-8');
      const promptConfig: AudioPromptConfig = JSON.parse(promptContent);

      // Cache the result
      this.promptCache.set(language, promptConfig);

      logger.info('Audio prompt loaded successfully', {
        language,
        languageName: promptConfig.languageName
      });

      return promptConfig;
    } catch (error) {
      logger.warn('Failed to load audio prompt, falling back to default', {
        language,
        error: error instanceof Error ? error.message : String(error)
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
    targetAgeOptions: string[]
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
    targetAge?: string
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
      promptConfig.targetAgeOptions
    );

    return {
      systemPrompt: processedSystemPrompt,
      instructions: promptConfig.instructions,
      language: promptConfig.language,
      languageName: promptConfig.languageName
    };
  }

  /**
   * Create enhanced text for TTS by combining the original text with instructions
   */
  static enhanceTextForTTS(
    originalText: string,
    systemPrompt: string,
    instructions: string[]
  ): string {
    // For TTS, we can prepend instructions to guide the synthesis
    // Note: This approach works better with advanced TTS models that understand context
    
    const instructionText = instructions.join('. ') + '.';
    
    // Create enhanced text with context
    const enhancedText = `[${systemPrompt}. ${instructionText}]\n\n${originalText}`;
    
    return enhancedText;
  }

  /**
   * Clear the prompt cache (useful for testing or dynamic reloading)
   */
  static clearCache(): void {
    this.promptCache.clear();
  }
}
