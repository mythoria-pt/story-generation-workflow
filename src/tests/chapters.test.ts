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

import { ChaptersService } from '../services/chapters';
import { getDatabase } from '@/db/connection';
import { logger } from '@/config/logger';

describe('ChaptersService', () => {
  let service: ChaptersService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
    service = new ChaptersService();
    jest.clearAllMocks();
  });

  it('saves chapter with incremented version', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ version: 1 }]),
          }),
        }),
      }),
    });
    const returningMock = jest.fn().mockResolvedValue([{ id: 'c1', version: 2 }]);
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: returningMock,
      }),
    });

    const result = await service.saveChapter({
      storyId: 's1',
      authorId: 'a1',
      chapterNumber: 1,
      title: 'T',
      htmlContent: '<p></p>',
    });

    expect(result.version).toBe(2);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('updates chapter image for latest version', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 'id1', version: 2 }]),
          }),
        }),
      }),
    });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: whereMock }),
    });

    await service.updateChapterImage('s1', 1, 'img');

    expect(whereMock).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('updates chapter audio for latest version', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 'id1', version: 2 }]),
          }),
        }),
      }),
    });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: whereMock }),
    });

    await service.updateChapterAudio('s1', 1, 'audio');

    expect(whereMock).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('returns latest versions for story chapters', async () => {
    const chaptersData = [
      {
        id: '1',
        chapterNumber: 1,
        title: 'v2',
        htmlContent: '',
        imageUri: null,
        audioUri: null,
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: '2',
        chapterNumber: 1,
        title: 'v1',
        htmlContent: '',
        imageUri: null,
        audioUri: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: '3',
        chapterNumber: 2,
        title: 'b',
        htmlContent: '',
        imageUri: null,
        audioUri: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue(chaptersData),
        }),
      }),
    });

    const result = await service.getStoryChapters('s1');
    expect(result).toHaveLength(2);
    expect(result[0].version).toBe(2);
    expect(result[1].chapterNumber).toBe(2);
  });
});
