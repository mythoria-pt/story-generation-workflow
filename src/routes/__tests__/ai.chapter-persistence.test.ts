import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetPersistedChapter = jest.fn();
const mockGetStoryContext = jest.fn();
const mockGetImageService = jest.fn();
const mockUpdateRun = jest.fn();

class MockChapterNotPersistedError extends Error {
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

jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: jest.fn(() => ({
    getTextService: jest.fn(),
    getImageService: mockGetImageService,
  })),
}));
jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({ getStoryContext: mockGetStoryContext })),
}));
jest.mock('@/services/chapters.js', () => ({
  ChapterNotPersistedError: MockChapterNotPersistedError,
  ChaptersService: jest.fn(() => ({ getPersistedChapter: mockGetPersistedChapter })),
}));
jest.mock('@/services/characters.js', () => ({ CharacterService: jest.fn(() => ({})) }));
jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => ({ updateRun: mockUpdateRun })),
}));
jest.mock('@/services/image-safety-service.js', () => ({
  ImageSafetyService: jest.fn(() => ({})),
}));
jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: jest.fn(() => ({})),
}));

import { aiRouter } from '../ai';

const app = express();
app.use(express.json());
app.use('/ai', aiRouter);

describe('POST /ai/image chapter persistence barrier', () => {
  const storyId = '00000000-0000-4000-8000-000000000001';
  const runId = '00000000-0000-4000-8000-000000000002';
  const chapterId = '00000000-0000-4000-8000-000000000003';

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRun.mockResolvedValue({ runId });
  });

  it('returns a non-retryable 409 before provider work when the exact chapter is not visible', async () => {
    mockGetPersistedChapter.mockResolvedValue(undefined);

    const response = await request(app).post('/ai/image').send({
      prompt: 'A safe illustration prompt',
      storyId,
      runId,
      chapterNumber: 1,
      chapterId,
      chapterVersion: 2,
      imageType: 'chapter',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      code: 'CHAPTER_NOT_PERSISTED',
      retryable: false,
      failedAt: 'validating_persisted_chapter',
      chapterNumber: 1,
    });
    expect(mockGetPersistedChapter).toHaveBeenCalledWith(storyId, 1, {
      id: chapterId,
      version: 2,
    });
    expect(mockGetStoryContext).not.toHaveBeenCalled();
    expect(mockGetImageService).not.toHaveBeenCalled();
    expect(mockUpdateRun).toHaveBeenCalledWith(runId, {
      failureStage: 'persist_chapter_image',
      failureCode: 'chapter_persistence_race',
      errorMessage: expect.any(String),
    });
  });
});
