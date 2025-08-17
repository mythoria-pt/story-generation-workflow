/**
 * Character Service
 * Provides operations for characters and their links to stories
 */

import { and, eq } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { characters, storyCharacters, type NewCharacter, type NewStoryCharacter } from '@/db/schema/index.js';
import { logger } from '@/config/logger.js';

export interface CreateCharacterInput {
  name: string;
  authorId: string;
  type?: string;
  role?: string;
  age?: string;
  traits?: string[];
  characteristics?: string;
  physicalDescription?: string;
  photoUrl?: string;
}

export class CharacterService {
  private db = getDatabase();

  async getCharactersByAuthor(authorId: string) {
    try {
      return await this.db
        .select()
        .from(characters)
        .where(eq(characters.authorId, authorId));
    } catch (error) {
      logger.error('Failed to get characters by author', {
        error: error instanceof Error ? error.message : String(error),
        authorId
      });
      throw error;
    }
  }

  async getCharacterById(characterId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(characters)
        .where(eq(characters.characterId, characterId))
        .limit(1);
      return row || null;
    } catch (error) {
      logger.error('Failed to get character by id', {
        error: error instanceof Error ? error.message : String(error),
        characterId
      });
      throw error;
    }
  }

  async createCharacter(input: CreateCharacterInput) {
    try {
      const values: NewCharacter = {
        name: input.name,
        authorId: input.authorId,
        type: input.type,
        age: (input.age as any) ?? undefined,
        traits: input.traits ?? [],
        characteristics: input.characteristics,
        physicalDescription: input.physicalDescription,
        photoUrl: input.photoUrl,
      };
      const [row] = await this.db
        .insert(characters)
        .values(values)
        .returning();
      return row;
    } catch (error) {
      logger.error('Failed to create character', {
        error: error instanceof Error ? error.message : String(error),
        input: { ...input, traits: Array.isArray(input.traits) ? `[len:${input.traits.length}]` : input.traits }
      });
      throw error;
    }
  }

  async addCharacterToStory(storyId: string, characterId: string, role?: string) {
    try {
      // Check if already linked
      const [existing] = await this.db
        .select()
        .from(storyCharacters)
        .where(and(eq(storyCharacters.storyId, storyId), eq(storyCharacters.characterId, characterId)))
        .limit(1);
      if (existing) return existing;

      const values: NewStoryCharacter = {
        storyId,
        characterId,
        role: role as any
      };
      const [link] = await this.db
        .insert(storyCharacters)
        .values(values)
        .returning();
      return link;
    } catch (error) {
      logger.warn('Failed to link character to story (may already be linked)', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        characterId
      });
      throw error;
    }
  }
}
