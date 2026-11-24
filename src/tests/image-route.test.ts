import express from 'express';
import request from 'supertest';
import { ImageGenerationBlockedError } from '@/ai/errors.js';
import { logger } from '@/config/logger.js';
import { aiRouter } from '@/routes/ai.js';

const mockGetStoryContext = jest.fn();
const mockGetPersistedChapter = jest.fn();
const mockStoreStepResult = jest.fn();
const mockUpdateRun = jest.fn();
const mockGenerate = jest.fn();
const mockComplete = jest.fn();
const mockUploadFile = jest.fn();

jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({
    getStoryContext: (...args: unknown[]) => mockGetStoryContext(...args),
    getStory: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('@/services/chapters.js', () => ({
  ...jest.requireActual('@/services/chapters.js'),
  ChaptersService: jest.fn(() => ({
    getPersistedChapter: (...args: unknown[]) => mockGetPersistedChapter(...args),
  })),
}));
jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => ({
    getStepResult: jest.fn().mockResolvedValue(null),
    storeStepResult: (...args: unknown[]) => mockStoreStepResult(...args),
    updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  })),
}));
jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: () => ({ uploadFile: (...args: unknown[]) => mockUploadFile(...args) }),
}));
jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: () => ({
    getImageService: () => ({ generate: (...args: unknown[]) => mockGenerate(...args) }),
    getTextService: () => ({ complete: (...args: unknown[]) => mockComplete(...args) }),
  }),
}));

const app = express();
app.use(express.json());
app.use('/ai', aiRouter);

const privateText = 'A private family scene by Lake Juniper';
const privateUrl = 'gs://images/private-illustration.jpg';
const body = {
  storyId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c21',
  runId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c22',
  chapterId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c23',
  chapterNumber: 1,
  chapterVersion: 2,
  imageType: 'chapter',
  prompt: privateText,
};

function logCalls() {
  return [logger.info, logger.warn, logger.error].flatMap((log) => jest.mocked(log).mock.calls);
}

async function postImageWithRetry() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const retryStarted = new Promise<void>((resolve) => {
      jest.mocked(logger.warn).mockImplementation((message) => {
        if (message === 'Image generation transient retry') resolve();
        return logger;
      });
    });
    const response = request(app)
      .post('/ai/image')
      .send(body)
      .then((result) => result);
    await Promise.race([retryStarted, response]);
    await jest.advanceTimersByTimeAsync(10000);
    return await response;
  } finally {
    jest.useRealTimers();
  }
}

describe('/ai/image request diagnostics', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetStoryContext.mockResolvedValue({
      story: {
        authorId: 'author',
        title: privateText,
        additionalRequests: '[MYTHORIA_BIOGRAPHER_V1]',
        imageGenerationInstructions: privateText,
      },
      characters: [],
    });
    mockGetPersistedChapter.mockResolvedValue({ id: body.chapterId, version: body.chapterVersion });
    mockUploadFile.mockResolvedValue(privateUrl);
  });

  it('correlates a transient retry with a successful upload and preserves its receipt', async () => {
    const transientError = Object.assign(new Error(privateText), { status: 503 });
    mockGenerate.mockRejectedValueOnce(transientError).mockResolvedValueOnce(Buffer.from('jpeg'));

    const response = await postImageWithRetry();

    expect(response.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const started = logCalls().find(([message]) => message === 'Image generation requested');
    expect(started?.[1]).toMatchObject({ runId: body.runId, imageRequestId: expect.any(String) });
    expect(logger.info).toHaveBeenCalledWith(
      'Image generation completed',
      expect.objectContaining({
        ...started?.[1],
        providerAttemptCount: 2,
        transientRetryCount: 1,
      }),
    );
    expect(mockStoreStepResult).toHaveBeenNthCalledWith(1, body.runId, 'generate_image_chapter_1', {
      status: 'running',
      result: expect.objectContaining({
        chapterId: body.chapterId,
        reconciliationStatus: 'expected',
      }),
    });
    expect(mockStoreStepResult).toHaveBeenNthCalledWith(2, body.runId, 'generate_image_chapter_1', {
      status: 'running',
      result: expect.objectContaining({ imageUrl: privateUrl, reconciliationStatus: 'uploaded' }),
    });
    const logs = JSON.stringify(logCalls());
    expect(logs).not.toContain(privateText);
    expect(logs).not.toContain(privateUrl);
  });

  it('reports exhausted safety recovery without leaking private provider messages', async () => {
    mockComplete.mockResolvedValue('A neutral landscape with mountains under an empty blue sky.');
    mockGenerate.mockImplementation(async () => {
      throw new ImageGenerationBlockedError({
        provider: 'test-provider',
        finishReasons: ['SAFETY'],
        message: privateText,
      });
    });

    const response = await request(app).post('/ai/image').send(body);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: 'Image generation failed',
      promptRewriteAttempted: true,
      fallbackAttempted: true,
    });
    expect(response.body).not.toHaveProperty('promptRewriteError');
    expect(response.body).not.toHaveProperty('fallbackError');
    expect(logger.warn).toHaveBeenCalledWith(
      'Image generation failed',
      expect.objectContaining({
        statusCode: 422,
        errorCode: 'IMAGE_SAFETY_BLOCKED',
        providerAttemptCount: 3,
        transientRetryCount: 0,
        promptRewriteAttempted: true,
        fallbackAttempted: true,
      }),
    );
    expect(JSON.stringify(logCalls())).not.toContain(privateText);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('retains HTTP 422 when a transient provider outage prevents the safety fallback', async () => {
    mockComplete.mockResolvedValue('UNABLE_TO_REWRITE: No safe rewrite available.');
    const transientError = Object.assign(
      new Error(privateText, {
        cause: new Error(`Provider details for ${privateUrl}`),
      }),
      { status: 503 },
    );
    mockGenerate
      .mockRejectedValueOnce(
        new ImageGenerationBlockedError({
          provider: 'test-provider',
          finishReasons: ['SAFETY'],
          message: privateText,
        }),
      )
      .mockRejectedValue(transientError);

    const response = await postImageWithRetry();

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: 'Image generation failed',
      promptRewriteAttempted: true,
      fallbackAttempted: true,
    });
    expect(response.body).not.toHaveProperty('fallbackError');
    expect(logger.warn).toHaveBeenCalledWith(
      'Image generation failed',
      expect.objectContaining({
        statusCode: 422,
        providerAttemptCount: 3,
        transientRetryCount: 1,
        promptRewriteAttempted: true,
        fallbackAttempted: true,
      }),
    );
    const logs = JSON.stringify(logCalls());
    expect(logs).not.toContain(privateText);
    expect(logs).not.toContain(privateUrl);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('rejects a malformed chapter image request before calling the provider', async () => {
    const response = await request(app)
      .post('/ai/image')
      .send({ ...body, chapterVersion: null });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid image request');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('preserves the terminal conflict for an unpersisted chapter', async () => {
    mockGetPersistedChapter.mockResolvedValueOnce(null);

    const response = await request(app).post('/ai/image').send(body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CHAPTER_NOT_PERSISTED', retryable: false });
    expect(mockUpdateRun).toHaveBeenCalledWith(
      body.runId,
      expect.objectContaining({
        failureStage: 'persist_chapter_image',
        failureCode: 'chapter_persistence_race',
      }),
    );
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
