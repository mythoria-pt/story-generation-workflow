/**
 * Prompt Service
 * Handles loading and processing of AI prompts from JSON files
 */

import { readFile } from 'fs/promises';
import { posix as pathPosix } from 'path';
import { logger } from '@/config/logger.js';
import { getPromptsPath } from '../shared/path-utils.js';

export interface PromptTemplate {
  systemPrompt?: string;
  userPrompt: string;
  outputFormat?: string;
  templateVariables?: Record<string, string>;
}

export interface ImageStyleTemplate {
  systemPrompt: string;
  style: string;
}

export interface ImageStylesCollection {
  [styleName: string]: ImageStyleTemplate;
}

export class PromptService {
  private static readonly PROMPTS_BASE_PATH = getPromptsPath();

  /**
   * Load a prompt template from JSON file
   */
  static async loadPrompt(locale: string, promptName: string): Promise<PromptTemplate> {
    try {
  const promptPath = pathPosix.join(this.PROMPTS_BASE_PATH, locale, `${promptName}.json`);
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
   * Load an image prompt template from JSON file
   * These are stored in src/prompts/images/
   */
  static async loadImagePrompt(imageType: string): Promise<PromptTemplate> {
    try {
  const promptPath = pathPosix.join(this.PROMPTS_BASE_PATH, 'images', `${imageType}.json`);
      const promptContent = await readFile(promptPath, 'utf-8');
      const promptTemplate = JSON.parse(promptContent) as PromptTemplate;

      logger.debug('Image prompt template loaded successfully', {
        imageType,
        promptPath
      });

      return promptTemplate;
    } catch (error) {
      logger.error('Failed to load image prompt template', {
        error: error instanceof Error ? error.message : String(error),
        imageType
      });
      throw new Error(`Failed to load image prompt template: images/${imageType}.json`);
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

    // Handle conditional sections (e.g., {{#customInstructions}}...{{/customInstructions}})
    // Process all variables for conditional logic
    for (const [key, value] of Object.entries(variables)) {
      const conditionalPattern = new RegExp(`\\{\\{#${key}\\}\\}(.*?)\\{\\{\\/${key}\\}\\}`, 'gs');
      
      if (value && String(value).trim() !== '') {
        // Replace conditional blocks with their content if value is truthy and not empty
        processedTemplate = processedTemplate.replace(conditionalPattern, '$1');
      } else {
        // Remove conditional blocks if value is falsy or empty
        processedTemplate = processedTemplate.replace(conditionalPattern, '');
      }
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

  /**
   * Load image styles configuration
   */
  static async loadImageStyles(): Promise<ImageStylesCollection> {
    try {
  const stylesPath = pathPosix.join(this.PROMPTS_BASE_PATH, 'imageStyles.json');
      const stylesContent = await readFile(stylesPath, 'utf-8');
      const imageStyles = JSON.parse(stylesContent) as ImageStylesCollection;

      logger.debug('Image styles loaded successfully', {
        stylesCount: Object.keys(imageStyles).length,
        stylesPath
      });

      return imageStyles;
    } catch (error) {
      logger.error('Failed to load image styles', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error('Failed to load image styles configuration');
    }
  }

  /**
   * Get image style prompt for a specific style
   */
  static async getImageStylePrompt(styleName: string): Promise<ImageStyleTemplate> {
    const imageStyles = await this.loadImageStyles();
      if (!imageStyles[styleName]) {
      logger.warn('Image style not found, using default', { styleName });
      // Return a default style if the requested one doesn't exist
      return {
        systemPrompt: "Create a high-quality image with attention to detail and composition.",
        style: "high quality, detailed, well-composed"
      };
    }

    return imageStyles[styleName];
  }

  /**
   * Get all available image style names
   */
  static async getAvailableImageStyles(): Promise<string[]> {
    const imageStyles = await this.loadImageStyles();
    return Object.keys(imageStyles);
  }
}
