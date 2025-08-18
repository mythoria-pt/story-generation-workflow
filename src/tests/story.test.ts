import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/db/connection', () => ({
  getDatabase: jest.fn(),
}));

jest.mock('@/shared/utils', () => ({
  retry: jest.fn((fn: () => Promise<unknown>) => fn()),
}));

import { StoryService } from '../services/story';
import { getDatabase } from '@/db/connection';
import { retry } from '@/shared/utils';
import { logger } from '@/config/logger';

describe('StoryService', () => {
  let service: StoryService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      select: jest.fn(),
      update: jest.fn(),
    };
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
    service = new StoryService();
    jest.clearAllMocks();
  });

  it('should return true when story exists', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ storyId: 's1' }]),
        }),
      }),
    });

    const result = await service.storyExists('s1');
    expect(result).toBe(true);
  });

  it('should return false when story does not exist', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await service.storyExists('s1');
    expect(result).toBe(false);
  });

  it('should return null for invalid storyId', async () => {
    const result = await service.getStoryContext('');
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it('should load story context with characters', async () => {
    const story = {
      storyId: 's1',
      authorId: 'a1',
      title: 'Title',
      plotDescription: null,
      synopsis: null,
      place: null,
      additionalRequests: null,
      targetAudience: null,
      novelStyle: null,
      graphicalStyle: null,
      storyLanguage: 'en',
      chapterCount: 2,
    };
    const characters = [
      {
        characterId: 'c1',
        name: 'Hero',
        type: null,
        age: null,
        traits: null,
        characteristics: null,
        physicalDescription: null,
        role: 'lead',
      },
    ];

    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([story]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(characters),
          }),
        }),
      });

    const result = await service.getStoryContext('s1');
    expect(result?.story.title).toBe('Title');
    expect(result?.characters).toHaveLength(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it('should update story URIs with retry', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const updates = { htmlUri: 'html', hasAudio: true };
    const result = await service.updateStoryUris('s1', updates);

    expect(result).toBe(true);
    expect(retry).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(updates);
  });

  it('should group chapters in getStoryForPrint', async () => {
    const story = {
      storyId: 's1',
      title: 'Title',
      customAuthor: null,
      dedicationMessage: null,
      coverUri: null,
      backcoverUri: null,
      chapterCount: 2,
      storyLanguage: 'en',
      createdAt: new Date(),
      synopsis: null,
      graphicalStyle: null,
      targetAudience: null,
    };

    const chaptersData = [
      { chapterNumber: 1, title: 'A2', content: 'v2', imageUri: 'i2', version: 2 },
      { chapterNumber: 1, title: 'A', content: 'v1', imageUri: 'i1', version: 1 },
      { chapterNumber: 2, title: 'B', content: 'v1', imageUri: 'i3', version: 1 },
    ];

    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([story]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue(chaptersData),
          }),
        }),
      });

    const result = await service.getStoryForPrint('s1');
    expect(result?.chapters).toHaveLength(2);
    expect(result?.chapters[0].title).toBe('A2');
    expect(logger.info).toHaveBeenCalled();
  });
});

