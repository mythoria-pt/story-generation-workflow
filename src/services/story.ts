/**
 * Story Service
 * Handles database operations for stories and related data
 */

import { eq, desc } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { stories, storyCharacters, chapters } from '@/db/schema/index.js';
import { characters } from '@/db/schema/characters.js';
import { authors } from '@/db/schema/authors.js';
import { retry } from '@/shared/utils.js';
import { logger } from '@/config/logger.js';

export interface StoryContext {
  story: {
    storyId: string;
    authorId: string;
    title: string;
    plotDescription?: string | undefined;
    synopsis?: string | undefined;
    place?: string | undefined;
    additionalRequests?: string | undefined;
    imageGenerationInstructions?: string | undefined;
    targetAudience?: string | undefined;
    novelStyle?: string | undefined;
    graphicalStyle?: string | undefined;
    storyLanguage: string;
    chapterCount?: number | undefined;
  };
  characters: Array<{
    characterId: string;
    name: string;
    type?: string | undefined;
    role?: string | undefined;
    age?: string | undefined;
    traits?: string[] | undefined;
    characteristics?: string | undefined;
    physicalDescription?: string | undefined;
  }>;
}

export class StoryService {
  private db = getDatabase();

  /**
   * Check if a story exists in the database
   */
  async storyExists(storyId: string): Promise<boolean> {
    try {
      if (!storyId || typeof storyId !== 'string') {
        return false;
      }

      const [story] = await this.db
        .select({ storyId: stories.storyId })
        .from(stories)
        .where(eq(stories.storyId, storyId))
        .limit(1);

      return !!story;
    } catch (error) {
      logger.error('Failed to check story existence', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      return false;
    }
  }

  /**
   * Get complete story context including characters
   */
  async getStoryContext(storyId: string): Promise<StoryContext | null> {
    try {
      // Validate input
      if (!storyId || typeof storyId !== 'string') {
        logger.error('Invalid storyId provided to getStoryContext', {
          storyId: String(storyId),
          type: typeof storyId,
        });
        return null;
      }

      // Get story details
      const [story] = await this.db.select().from(stories).where(eq(stories.storyId, storyId));
      if (!story) {
        logger.warn('Story not found in getStoryContext', {
          storyId,
          method: 'getStoryContext',
          timestamp: new Date().toISOString(),
        });
        return null;
      }

      // Get story characters with their details
      const storyCharactersData = await this.db
        .select({
          characterId: characters.characterId,
          name: characters.name,
          type: characters.type,
          age: characters.age,
          traits: characters.traits,
          characteristics: characters.characteristics,
          physicalDescription: characters.physicalDescription,
          role: storyCharacters.role,
        })
        .from(storyCharacters)
        .innerJoin(characters, eq(storyCharacters.characterId, characters.characterId))
        .where(eq(storyCharacters.storyId, storyId));

      logger.info('Story context loaded successfully', {
        storyId,
        title: story.title,
        charactersCount: storyCharactersData.length,
        hasChapterCount: !!story.chapterCount,
      });
      return {
        story: {
          storyId: story.storyId,
          authorId: story.authorId,
          title: story.title,
          plotDescription: story.plotDescription || undefined,
          synopsis: story.synopsis || undefined,
          place: story.place || undefined,
          additionalRequests: story.additionalRequests || undefined,
          imageGenerationInstructions: story.imageGenerationInstructions || undefined,
          targetAudience: story.targetAudience || undefined,
          novelStyle: story.novelStyle || undefined,
          graphicalStyle: story.graphicalStyle || undefined,
          storyLanguage: story.storyLanguage,
          chapterCount: story.chapterCount || undefined,
        },
        characters: storyCharactersData.map((char) => ({
          characterId: char.characterId,
          name: char.name,
          ...(char.type ? { type: char.type } : {}),
          ...(char.role ? { role: char.role } : {}),
          ...(char.age ? { age: char.age } : {}),
          ...(Array.isArray(char.traits) && char.traits.length ? { traits: char.traits } : {}),
          ...(char.characteristics ? { characteristics: char.characteristics } : {}),
          ...(char.physicalDescription ? { physicalDescription: char.physicalDescription } : {}),
        })),
      };
    } catch (error) {
      logger.error('Failed to get story context', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
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
        .select({
          storyId: stories.storyId,
          authorId: stories.authorId,
          title: stories.title,
          plotDescription: stories.plotDescription,
          storyLanguage: stories.storyLanguage,
          synopsis: stories.synopsis,
          place: stories.place,
          additionalRequests: stories.additionalRequests,
          targetAudience: stories.targetAudience,
          novelStyle: stories.novelStyle,
          graphicalStyle: stories.graphicalStyle,
          chapterCount: stories.chapterCount,
          status: stories.status,
          features: stories.features,
          deliveryAddress: stories.deliveryAddress,
          customAuthor: stories.customAuthor,
          dedicationMessage: stories.dedicationMessage,
          audiobookUri: stories.audiobookUri,
          coverUri: stories.coverUri,
          backcoverUri: stories.backcoverUri,
          slug: stories.slug,
          isPublic: stories.isPublic,
          isFeatured: stories.isFeatured,
          featureImageUri: stories.featureImageUri,
          createdAt: stories.createdAt,
          updatedAt: stories.updatedAt,
          storyGenerationStatus: stories.storyGenerationStatus,
          storyGenerationCompletedPercentage: stories.storyGenerationCompletedPercentage,
          audiobookStatus: stories.audiobookStatus,
          author: authors.displayName, // display name
          authorEmail: authors.email,
          authorPreferredLocale: authors.preferredLocale,
        })
        .from(stories)
        .innerJoin(authors, eq(stories.authorId, authors.authorId))
        .where(eq(stories.storyId, storyId));

      return story || null;
    } catch (error) {
      logger.error('Failed to get story', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      throw error;
    }
  }
  /**
   * Update story with URI fields
   */
  async updateStoryUris(
    storyId: string,
    updates: {
      audiobookUri?: object;
      hasAudio?: boolean;
      htmlUri?: string;
      interiorPdfUri?: string;
      coverPdfUri?: string;
    },
  ) {
    try {
      const updateData: Record<string, unknown> = {};

      if (updates.audiobookUri !== undefined) {
        updateData.audiobookUri = updates.audiobookUri;
      }
      if (updates.hasAudio !== undefined) {
        updateData.hasAudio = updates.hasAudio;
      }
      if (updates.interiorPdfUri !== undefined) {
        updateData.interiorPdfUri = updates.interiorPdfUri;
      }
      if (updates.coverPdfUri !== undefined) {
        updateData.coverPdfUri = updates.coverPdfUri;
      }

      // Use retry logic for database connection timeouts
      await retry(
        async () => {
          await this.db.update(stories).set(updateData).where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      ); // 3 retries, starting with 1s delay

      logger.info('Story URIs updated successfully', {
        storyId,
        updates: Object.keys(updateData),
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story URIs', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Update story completion percentage
   */
  async updateStoryCompletionPercentage(storyId: string, completionPercentage: number) {
    try {
      // Use retry logic for database connection timeouts
      await retry(
        async () => {
          await this.db
            .update(stories)
            .set({
              storyGenerationCompletedPercentage: completionPercentage,
              updatedAt: new Date(),
            })
            .where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      ); // 3 retries, starting with 1s delay

      logger.info('Story completion percentage updated', {
        storyId,
        completionPercentage,
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story completion percentage', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        completionPercentage,
      });
      throw error;
    }
  }

  /**
   * Update story status
   */
  async updateStoryStatus(storyId: string, status: 'draft' | 'writing' | 'published') {
    try {
      // Use retry logic for database connection timeouts
      await retry(
        async () => {
          await this.db
            .update(stories)
            .set({
              status,
              updatedAt: new Date(),
            })
            .where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      ); // 3 retries, starting with 1s delay

      logger.info('Story status updated', {
        storyId,
        status,
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story status', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        status,
      });
      throw error;
    }
  }

  /**
   * Update audiobook status
   */
  async updateAudiobookStatus(
    storyId: string,
    updates: {
      audiobookStatus?: string;
      audiobookUri?: object;
    },
  ) {
    try {
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (updates.audiobookStatus !== undefined) {
        updateData.audiobookStatus = updates.audiobookStatus;
      }
      if (updates.audiobookUri !== undefined) {
        updateData.audiobookUri = updates.audiobookUri;
      }

      await this.db.update(stories).set(updateData).where(eq(stories.storyId, storyId));

      logger.info('Audiobook status updated successfully', {
        storyId,
        updates: Object.keys(updateData),
      });

      return true;
    } catch (error) {
      logger.error('Failed to update audiobook status', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Update story cover URIs
   */
  async updateStoryCoverUris(
    storyId: string,
    updates: {
      coverUri?: string;
      backcoverUri?: string;
    },
  ) {
    try {
      const updateData: Record<string, unknown> = {};

      if (updates.coverUri !== undefined) {
        updateData.coverUri = updates.coverUri;
      }
      if (updates.backcoverUri !== undefined) {
        updateData.backcoverUri = updates.backcoverUri;
      }

      if (Object.keys(updateData).length === 0) {
        return true; // Nothing to update
      }

      updateData.updatedAt = new Date();

      // Use retry logic for database connection timeouts
      await retry(
        async () => {
          await this.db.update(stories).set(updateData).where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      ); // 3 retries, starting with 1s delay

      logger.info('Story cover URIs updated successfully', {
        storyId,
        updates: Object.keys(updateData),
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story cover URIs', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Get story data for print generation
   */
  async getStoryForPrint(storyId: string) {
    try {
      const [storyData] = await this.db
        .select({
          storyId: stories.storyId,
          title: stories.title,
          customAuthor: stories.customAuthor,
          dedicationMessage: stories.dedicationMessage,
          coverUri: stories.coverUri,
          backcoverUri: stories.backcoverUri,
          chapterCount: stories.chapterCount,
          storyLanguage: stories.storyLanguage,
          createdAt: stories.createdAt,
          synopsis: stories.synopsis,
          graphicalStyle: stories.graphicalStyle,
          targetAudience: stories.targetAudience,
        })
        .from(stories)
        .where(eq(stories.storyId, storyId));

      if (!storyData) {
        return null;
      }

      // Get actual chapters data from the chapters table (latest versions only)
      const allChapters = await this.db
        .select({
          chapterNumber: chapters.chapterNumber,
          title: chapters.title,
          content: chapters.htmlContent,
          imageUri: chapters.imageUri,
          version: chapters.version,
        })
        .from(chapters)
        .where(eq(chapters.storyId, storyId))
        .orderBy(chapters.chapterNumber, desc(chapters.version));

      // Group by chapter number and take the latest version
      const chaptersMap = new Map();
      for (const chapter of allChapters) {
        if (!chaptersMap.has(chapter.chapterNumber)) {
          chaptersMap.set(chapter.chapterNumber, chapter);
        }
      }

      const chaptersFromDb = Array.from(chaptersMap.values()).sort(
        (a, b) => a.chapterNumber - b.chapterNumber,
      );

      // Transform chapters to the format expected by the print service
      const chaptersForPrint = chaptersFromDb.map((chapter) => ({
        title: chapter.title,
        content: chapter.content || 'No content available',
        imageUri: chapter.imageUri,
      }));

      logger.info('Story data fetched for print generation', {
        storyId,
        title: storyData.title,
        chaptersFromDb: chaptersFromDb.length,
        chaptersForPrint: chaptersForPrint.length,
      });

      return {
        ...storyData,
        chapters: chaptersForPrint,
      };
    } catch (error) {
      logger.error('Failed to get story for print', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      throw error;
    }
  }

  /**
   * Update story with print PDF URLs
   */
  async updateStoryPrintUrls(
    storyId: string,
    updates: {
      interiorPdfUri?: string;
      coverPdfUri?: string;
    },
  ) {
    try {
      const updateData: Record<string, unknown> = {};

      if (updates.interiorPdfUri !== undefined) {
        updateData.interiorPdfUri = updates.interiorPdfUri;
      }
      if (updates.coverPdfUri !== undefined) {
        updateData.coverPdfUri = updates.coverPdfUri;
      }

      await retry(
        async () => {
          await this.db.update(stories).set(updateData).where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      );

      logger.info('Story print URLs updated successfully', {
        storyId,
        updates: Object.keys(updateData),
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story print URLs', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Update story language and selected text fields
   * - Will update updatedAt automatically
   */
  async updateStoryLanguageAndTexts(
    storyId: string,
    updates: {
      storyLanguage: string;
      title?: string;
      synopsis?: string;
      plotDescription?: string;
    },
  ) {
    try {
      const updateData: Record<string, unknown> = {
        storyLanguage: updates.storyLanguage,
        updatedAt: new Date(),
      };

      if (typeof updates.title === 'string') {
        updateData.title = updates.title;
      }
      if (typeof updates.synopsis === 'string') {
        updateData.synopsis = updates.synopsis;
      }
      if (typeof updates.plotDescription === 'string') {
        updateData.plotDescription = updates.plotDescription;
      }

      await retry(
        async () => {
          await this.db.update(stories).set(updateData).where(eq(stories.storyId, storyId));
        },
        3,
        1000,
      );

      logger.info('Story language/texts updated successfully', {
        storyId,
        fields: Object.keys(updateData),
      });

      return true;
    } catch (error) {
      logger.error('Failed to update story language/texts', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      throw error;
    }
  }
}
