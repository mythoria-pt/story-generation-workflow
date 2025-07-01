/**
 * Message Service
 * Handles loading localized messages for story assembly
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '@/config/logger.js';

export interface MessageData {
  Story: {
    credits: string;
    tableOfContents: string;
    storyImaginedBy: string;
    craftedWith: string;
    byAuthor: string;
  };
}

export class MessageService {
  private static messagesCache = new Map<string, MessageData>();

  /**
   * Load messages for a given locale
   */
  static async loadMessages(locale: string): Promise<MessageData> {
    // Check cache first
    if (this.messagesCache.has(locale)) {
      const cachedMessages = this.messagesCache.get(locale);
      if (cachedMessages) {
        return cachedMessages;
      }
    }

    try {
      // Convert locale format (en-US -> en-US, pt -> pt-PT, etc.)
      const normalizedLocale = this.normalizeLocale(locale);
      
      const messagesPath = join(process.cwd(), 'src', 'messages', normalizedLocale, 'common.json');
      const messagesContent = readFileSync(messagesPath, 'utf-8');
      const messages = JSON.parse(messagesContent) as MessageData;

      // Cache the messages
      this.messagesCache.set(locale, messages);
      this.messagesCache.set(normalizedLocale, messages);

      return messages;
    } catch (error) {
      logger.warn(`Failed to load messages for locale ${locale}, falling back to en-US`, { error });
      
      // Fallback to en-US
      if (locale !== 'en-US') {
        return this.loadMessages('en-US');
      }
        // If even en-US fails, return default messages
      const defaultMessages: MessageData = {
        Story: {
          credits: "Story imagined by {author}, crafted using the [Mythoria app](https://mythoria.pt).",
          tableOfContents: "Table of Contents",
          storyImaginedBy: "This story was imagined by",
          craftedWith: "Crafted with:",
          byAuthor: "by {author}"
        }
      };
      
      this.messagesCache.set(locale, defaultMessages);
      return defaultMessages;
    }
  }

  /**
   * Get credits message with author substitution
   */
  static async getCreditsMessage(locale: string, author: string): Promise<string> {
    const messages = await this.loadMessages(locale);
    return messages.Story.credits.replace('{author}', author);
  }

  /**
   * Get table of contents title
   */
  static async getTableOfContentsTitle(locale: string): Promise<string> {
    const messages = await this.loadMessages(locale);
    return messages.Story.tableOfContents;
  }

  /**
   * Get "story imagined by" message with author substitution
   */
  static async getStoryImaginedByMessage(locale: string, author: string): Promise<string> {
    const messages = await this.loadMessages(locale);
    return `${messages.Story.storyImaginedBy} <i class="mythoria-author-emphasis">${author}</i>.`;
  }

  /**
   * Get "crafted with" message
   */
  static async getCraftedWithMessage(locale: string): Promise<string> {
    const messages = await this.loadMessages(locale);
    return messages.Story.craftedWith;
  }

  /**
   * Get "by author" message with author substitution
   */
  static async getByAuthorMessage(locale: string, author: string): Promise<string> {
    const messages = await this.loadMessages(locale);
    return messages.Story.byAuthor.replace('{author}', author);
  }

  /**
   * Normalize locale format for consistency
   */
  private static normalizeLocale(locale: string): string {
    // Map common locale formats to our supported locales
    const localeMap: Record<string, string> = {
      'en': 'en-US',
      'english': 'en-US',
      'pt': 'pt-PT',
      'portuguese': 'pt-PT',
      'pt-BR': 'pt-PT', // Use pt-PT as fallback for Brazilian Portuguese
    };

    const normalized = localeMap[locale.toLowerCase()] || locale;
    
    // Check if we support this locale, otherwise fallback to en-US
    const supportedLocales = ['en-US', 'pt-PT'];
    return supportedLocales.includes(normalized) ? normalized : 'en-US';
  }

  /**
   * Get all supported locales
   */
  static getSupportedLocales(): string[] {
    return ['en-US', 'pt-PT'];
  }
}
