import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetRun = jest.fn();
const mockUpdateRun = jest.fn();
const mockStoreStepResult = jest.fn();
const mockUpdateChapterImage = jest.fn();
const mockUpdateStoryProgress = jest.fn();

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

jest.mock('@/config/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/services/runs.js', () => ({
  RunStoryConflictError: class extends Error {},
  RunsService: jest.fn(() => ({
    getRun: mockGetRun,
    updateRun: mockUpdateRun,
    storeStepResult: mockStoreStepResult,
  })),
}));
jest.mock('@/services/chapters.js', () => ({
  ChapterNotPersistedError: MockChapterNotPersistedError,
  ChaptersService: jest.fn(() => ({ updateChapterImage: mockUpdateChapterImage })),
}));
jest.mock('@/services/story.js', () => ({ StoryService: jest.fn(() => ({})) }));
jest.mock('@/services/tts.js', () => ({ TTSService: jest.fn(() => ({})) }));
jest.mock('@/services/progress-tracker.js', () => ({
  ProgressTrackerService: jest.fn(() => ({ updateStoryProgress: mockUpdateStoryProgress })),
}));
jest.mock('@/services/analytics.js', () => ({
  analyticsReconciliationService: { reconcileRecentTerminalRuns: jest.fn() },
}));
jest.mock('@/middleware/schedulerAuth.js', () => ({
  schedulerAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { internalRouter } from '../internal';

const app = express();
app.use(express.json());
app.use('/internal', internalRouter);

describe('POST /internal/runs/:runId/image', () => {
  const runId = '00000000-0000-4000-8000-000000000001';
  const storyId = '00000000-0000-4000-8000-000000000002';
  const chapterId = '00000000-0000-4000-8000-000000000003';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRun.mockResolvedValue({ runId, storyId });
    mockUpdateRun.mockResolvedValue({ runId });
    mockStoreStepResult.mockResolvedValue(undefined);
    mockUpdateStoryProgress.mockResolvedValue(undefined);
  });

  it('persists a chapter image only against the exact chapter identity', async () => {
    mockUpdateChapterImage.mockResolvedValue({ id: chapterId, version: 2 });

    const response = await request(app).post(`/internal/runs/${runId}/image`).send({
      chapterNumber: 1,
      chapterId,
      chapterVersion: 2,
      imageType: 'chapter',
      imageUrl: 'https://storage.googleapis.com/example/chapter.jpg',
      filename: 'chapter.jpg',
    });

    expect(response.status).toBe(200);
    expect(mockUpdateChapterImage).toHaveBeenCalledWith(storyId, 1, expect.any(String), {
      id: chapterId,
      version: 2,
    });
    expect(mockStoreStepResult).toHaveBeenCalledWith(
      runId,
      'generate_image_chapter_1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('returns a stable non-retryable 409 and records structured telemetry for a missing chapter', async () => {
    mockUpdateChapterImage.mockRejectedValue(
      new MockChapterNotPersistedError(storyId, 1, chapterId, 2),
    );

    const response = await request(app).post(`/internal/runs/${runId}/image`).send({
      chapterNumber: 1,
      chapterId,
      chapterVersion: 2,
      imageType: 'chapter',
      imageUrl: 'https://storage.googleapis.com/example/chapter.jpg',
      filename: 'chapter.jpg',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      code: 'CHAPTER_NOT_PERSISTED',
      retryable: false,
      chapterNumber: 1,
    });
    expect(mockUpdateRun).toHaveBeenCalledWith(runId, {
      failureStage: 'persist_chapter_image',
      failureCode: 'chapter_persistence_race',
      errorMessage: expect.any(String),
    });
    expect(mockStoreStepResult).toHaveBeenCalledWith(
      runId,
      'generate_image_chapter_1',
      expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({ failureCode: 'chapter_persistence_race' }),
      }),
    );
  });
});
