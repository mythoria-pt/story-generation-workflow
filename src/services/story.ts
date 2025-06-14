/**
 * Story Service
 * Handles database operations for stories and related data
 */

import { eq } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { stories, storyCharacters } from '@/db/schema/index.js';
import { characters } from '@/db/schema/characters.js';
import { logger } from '@/config/logger.js';

export interface StoryContext {
  story: {
    storyId: string;
    title: string;
    plotDescription?: string | undefined;
    synopsis?: string | undefined;
    place?: string | undefined;
    additionalRequests?: string | undefined;
    targetAudience?: string | undefined;
    novelStyle?: string | undefined;
    graphicalStyle?: string | undefined;
  };
  characters: Array<{
    characterId: string;
    name: string;
    type?: string | undefined;
    role?: string | undefined;
    passions?: string | undefined;
    superpowers?: string | undefined;
    physicalDescription?: string | undefined;
  }>;
}

export class StoryService {
  private db = getDatabase();

  /**
   * Get complete story context including characters
   */
  async getStoryContext(storyId: string): Promise<StoryContext | null> {
    try {
      // Get story details
      const [story] = await this.db
        .select()
        .from(stories)
        .where(eq(stories.storyId, storyId));

      if (!story) {
        logger.warn('Story not found', { storyId });
        return null;
      }

      // Get story characters with their details
      const storyCharactersData = await this.db
        .select({
          characterId: characters.characterId,
          name: characters.name,
          type: characters.type,
          passions: characters.passions,
          superpowers: characters.superpowers,
          physicalDescription: characters.physicalDescription,
          role: storyCharacters.role,
        })
        .from(storyCharacters)
        .innerJoin(characters, eq(storyCharacters.characterId, characters.characterId))
        .where(eq(storyCharacters.storyId, storyId));

      logger.info('Story context loaded successfully', {
        storyId,
        title: story.title,
        charactersCount: storyCharactersData.length
      });

      return {
        story: {
          storyId: story.storyId,
          title: story.title,
          plotDescription: story.plotDescription || undefined,
          synopsis: story.synopsis || undefined,
          place: story.place || undefined,
          additionalRequests: story.additionalRequests || undefined,
          targetAudience: story.targetAudience || undefined,
          novelStyle: story.novelStyle || undefined,
          graphicalStyle: story.graphicalStyle || undefined,
        },
        characters: storyCharactersData.map(char => ({
          characterId: char.characterId,
          name: char.name,
          type: char.type || undefined,
          role: char.role || undefined,
          passions: char.passions || undefined,
          superpowers: char.superpowers || undefined,
          physicalDescription: char.physicalDescription || undefined,
        }))
      };
    } catch (error) {
      logger.error('Failed to get story context', {
        error: error instanceof Error ? error.message : String(error),
        storyId
      });
      throw error;
    }
  }

  /**
   * Get basic story information
   */
  async getStory(storyId: string) {
    try {
      const [story] = await this.db
        .select()
        .from(stories)
        .where(eq(stories.storyId, storyId));

      return story || null;
    } catch (error) {
      logger.error('Failed to get story', {
        error: error instanceof Error ? error.message : String(error),
        storyId
      });
      throw error;
    }
  }
}
