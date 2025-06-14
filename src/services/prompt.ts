/**
 * Prompt Service
 * Handles loading and processing of AI prompts from JSON files
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/config/logger.js';

export interface PromptTemplate {
  systemPrompt?: string;
  userPrompt: string;
  outputFormat?: string;
  templateVariables?: Record<string, string>;
}

export class PromptService {
  private static readonly PROMPTS_BASE_PATH = join(process.cwd(), 'src', 'prompts');

  /**
   * Load a prompt template from JSON file
   */
  static async loadPrompt(locale: string, promptName: string): Promise<PromptTemplate> {
    try {
      const promptPath = join(this.PROMPTS_BASE_PATH, locale, `${promptName}.json`);
      const promptContent = await readFile(promptPath, 'utf-8');
      const promptTemplate = JSON.parse(promptContent) as PromptTemplate;

      logger.debug('Prompt template loaded successfully', {
        locale,
        promptName,
        promptPath
      });

      return promptTemplate;
    } catch (error) {
      logger.error('Failed to load prompt template', {
        error: error instanceof Error ? error.message : String(error),
        locale,
        promptName
      });
      throw new Error(`Failed to load prompt template: ${locale}/${promptName}`);
    }
  }

  /**
   * Process a prompt template by replacing variables
   */
  static processPrompt(template: string, variables: Record<string, unknown>): string {
    let processedTemplate = template;

    // Replace template variables (e.g., {{variableName}})
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      const replacement = String(value ?? '');
      processedTemplate = processedTemplate.replace(new RegExp(placeholder, 'g'), replacement);
    }

    return processedTemplate;
  }

  /**
   * Build a complete prompt with system and user messages
   */
  static buildPrompt(promptTemplate: PromptTemplate, variables: Record<string, unknown>): string {
    const systemPrompt = promptTemplate.systemPrompt 
      ? this.processPrompt(promptTemplate.systemPrompt, variables)
      : '';
    
    const userPrompt = this.processPrompt(promptTemplate.userPrompt, variables);

    // Combine system and user prompts
    if (systemPrompt) {
      return `${systemPrompt}\n\n${userPrompt}`;
    }
    
    return userPrompt;
  }
}
