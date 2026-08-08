/**
 * Chapters Service
 * Handles database operations for story chapters
 */

import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { chapters } from '@/db/schema/index.js';
import { retry } from '@/shared/utils.js';
import { logger } from '@/config/logger.js';

export interface ChapterData {
  storyId: string;
  authorId: string;
  chapterNumber: number;
  title: string;
  htmlContent: string;
  imageUri?: string;
  audioUri?: string;
}

export interface ChapterIdentity {
  id: string;
  version: number;
}

export class ChapterNotPersistedError extends Error {
  readonly code = 'CHAPTER_NOT_PERSISTED';
  readonly retryable = false;

  constructor(
    readonly storyId: string,
    readonly chapterNumber: number,
    readonly chapterId?: string,
    readonly chapterVersion?: number,
  ) {
    super(`Chapter not found: story ${storyId}, chapter ${chapterNumber}`);
    this.name = 'ChapterNotPersistedError';
  }
}

export class ChaptersService {
  private db = getDatabase();

  /**
   * Save or update a chapter
   * Automatically handles version incrementation
   */
  async saveChapter(data: ChapterData): Promise<{ id: string; version: number }> {
    try {
      // Get the latest version for this story and chapter
      const latestVersion = await this.getLatestVersion(data.storyId, data.chapterNumber);
      const newVersion = latestVersion + 1;

      const chapterData = {
        storyId: data.storyId,
        authorId: data.authorId,
        version: newVersion,
        chapterNumber: data.chapterNumber,
        title: data.title,
        htmlContent: data.htmlContent,
        imageUri: data.imageUri || null,
        audioUri: data.audioUri || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Use retry logic for database connection timeouts
      const [createdChapter] = await retry(
        async () => {
          return await this.db
            .insert(chapters)
            .values(chapterData)
            .returning({ id: chapters.id, version: chapters.version });
        },
        3,
        1000,
      );

      if (!createdChapter) {
        throw new Error('Failed to create chapter');
      }

      logger.info('Chapter saved successfully', {
        storyId: data.storyId,
        chapterNumber: data.chapterNumber,
        version: newVersion,
        id: createdChapter.id,
      });

      return createdChapter;
    } catch (error) {
      logger.error('Failed to save chapter', {
        error: error instanceof Error ? error.message : String(error),
        storyId: data.storyId,
        chapterNumber: data.chapterNumber,
      });
      throw error;
    }
  }

  /**
   * Update chapter image URI
   */
  async updateChapterImage(
    storyId: string,
    chapterNumber: number,
    imageUri: string,
    expected?: ChapterIdentity,
  ): Promise<ChapterIdentity> {
    try {
      const updatedChapter = await retry(
        async () => {
          const chapter = await this.getPersistedChapter(storyId, chapterNumber, expected);
          if (!chapter) {
            throw new ChapterNotPersistedError(
              storyId,
              chapterNumber,
              expected?.id,
              expected?.version,
            );
          }

          const [updated] = await this.db
            .update(chapters)
            .set({
              imageUri,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chapters.id, chapter.id),
                eq(chapters.storyId, storyId),
                eq(chapters.chapterNumber, chapterNumber),
                eq(chapters.version, chapter.version),
              ),
            )
            .returning({ id: chapters.id, version: chapters.version });
          if (!updated) {
            throw new ChapterNotPersistedError(storyId, chapterNumber, chapter.id, chapter.version);
          }
          return updated;
        },
        2,
        1000,
      );

      logger.info('Chapter image updated successfully', {
        storyId,
        chapterNumber,
        chapterId: updatedChapter.id,
        version: updatedChapter.version,
        imageUri,
      });
      return updatedChapter;
    } catch (error) {
      logger.error('Failed to update chapter image', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber,
        imageUri,
      });
      throw error;
    }
  }

  async getPersistedChapter(
    storyId: string,
    chapterNumber: number,
    expected?: ChapterIdentity,
  ): Promise<ChapterIdentity | null> {
    const conditions = [
      eq(chapters.storyId, storyId),
      eq(chapters.chapterNumber, chapterNumber),
      ...(expected ? [eq(chapters.id, expected.id), eq(chapters.version, expected.version)] : []),
    ];
    const [chapter] = await this.db
      .select({ id: chapters.id, version: chapters.version })
      .from(chapters)
      .where(and(...conditions))
      .orderBy(desc(chapters.version))
      .limit(1);
    return chapter ?? null;
  }

  /**
   * Update chapter audio URI for the latest version
   */
  async updateChapterAudio(
    storyId: string,
    chapterNumber: number,
    audioUri: string,
  ): Promise<void> {
    try {
      // Get the latest version of this chapter
      const [latestChapter] = await this.db
        .select({ id: chapters.id, version: chapters.version })
        .from(chapters)
        .where(and(eq(chapters.storyId, storyId), eq(chapters.chapterNumber, chapterNumber)))
        .orderBy(desc(chapters.version))
        .limit(1);

      if (!latestChapter) {
        throw new Error(`Chapter not found: story ${storyId}, chapter ${chapterNumber}`);
      }

      // Update the audio URI
      await retry(
        async () => {
          await this.db
            .update(chapters)
            .set({
              audioUri,
              updatedAt: new Date(),
            })
            .where(eq(chapters.id, latestChapter.id));
        },
        3,
        1000,
      );

      logger.info('Chapter audio updated successfully', {
        storyId,
        chapterNumber,
        version: latestChapter.version,
        audioUri,
      });
    } catch (error) {
      logger.error('Failed to update chapter audio', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber,
        audioUri,
      });
      throw error;
    }
  }

  /**
   * Get latest version number for a specific story and chapter
   */
  private async getLatestVersion(storyId: string, chapterNumber: number): Promise<number> {
    try {
      const [latestChapter] = await this.db
        .select({ version: chapters.version })
        .from(chapters)
        .where(and(eq(chapters.storyId, storyId), eq(chapters.chapterNumber, chapterNumber)))
        .orderBy(desc(chapters.version))
        .limit(1);

      return latestChapter?.version || 0;
    } catch (error) {
      logger.error('Failed to get latest version', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        chapterNumber,
      });
      return 0;
    }
  }

  /**
   * Get all chapters for a story (latest versions)
   */
  async getStoryChapters(storyId: string): Promise<
    Array<{
      id: string;
      chapterNumber: number;
      title: string;
      htmlContent: string;
      imageUri: string | null;
      audioUri: string | null;
      version: number;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    try {
      // Get the latest version for each chapter
      const latestChapters = await this.db
        .select()
        .from(chapters)
        .where(eq(chapters.storyId, storyId))
        .orderBy(chapters.chapterNumber, desc(chapters.version));

      // Group by chapter number and take the latest version
      const chaptersMap = new Map();
      for (const chapter of latestChapters) {
        if (!chaptersMap.has(chapter.chapterNumber)) {
          chaptersMap.set(chapter.chapterNumber, chapter);
        }
      }

      const result = Array.from(chaptersMap.values()).sort(
        (a, b) => a.chapterNumber - b.chapterNumber,
      );

      logger.info('Retrieved story chapters', {
        storyId,
        chapterCount: result.length,
      });

      return result;
    } catch (error) {
      logger.error('Failed to get story chapters', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
      });
      throw error;
    }
  }
}
