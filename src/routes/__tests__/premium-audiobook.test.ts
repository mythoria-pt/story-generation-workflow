import express from 'express';
import request from 'supertest';

const mockGetStory = jest.fn();
const mockReserve = jest.fn();
const mockClaim = jest.fn();
const mockGetRun = jest.fn();
const mockUpdateRun = jest.fn();
const mockMarkRunning = jest.fn();
const mockRecordTerminal = jest.fn();
const mockGetBucket = jest.fn();
const mockReadManifest = jest.fn();
const mockSynthesize = jest.fn();
const mockReturning = jest.fn();
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));

jest.mock('@/config/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/db/connection.js', () => ({
  getDatabase: () => ({ update: () => ({ set: mockSet }) }),
}));
jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({ getStory: mockGetStory })),
}));
jest.mock('@/services/runs.js', () => ({
  RunStoryConflictError: class extends Error {},
  RunsService: jest.fn(() => ({
    reserveRun: mockReserve,
    claimRun: mockClaim,
    getRun: mockGetRun,
    updateRun: mockUpdateRun,
  })),
}));
jest.mock('@/services/analytics.js', () => ({
  analyticsReconciliationService: {
    markProductRunRunning: mockMarkRunning,
    recordTerminalRun: mockRecordTerminal,
  },
}));
jest.mock('@/services/premium-book-storage.js', () => ({
  getPremiumBucket: mockGetBucket,
  readPremiumManifest: mockReadManifest,
}));
jest.mock('@/services/tts.js', () => ({
  TTSService: jest.fn(() => ({ generateChapterAudioFromText: mockSynthesize })),
}));

import { premiumAudiobookRouter } from '../premium-audiobook.js';

const key = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';
const app = express();
app.use(express.json(), premiumAudiobookRouter);
const storyId = 'eb417f3e-ffb1-4168-958e-ddc463ebb00f';
const revision = 'af14c317-c9c8-4922-87e2-67983cd2ae81';
const ownerId = '89a702ee-7a9b-4eb2-8ef3-f5a6992437cd';
const runId = 'd65bb5f3-204a-479d-b4df-9ee71f6c513e';
const input = { storyId, revision, runId, executionId: 'execution-1' };
const run = {
  storyId,
  runId,
  gcpWorkflowExecution: input.executionId,
  status: 'running',
  metadata: { actionType: 'audiobook_generation', premiumRevision: revision },
};
const story = {
  storyId,
  authorId: ownerId,
  status: 'published',
  features: {
    premiumBook: {
      version: 1,
      type: 'premium_children',
      state: 'published',
      revision,
      ownerId,
      audience: 'children_0-2',
      manifest: { key: 'manifest.json', generation: '1', sha256: 'e'.repeat(64), bytes: 5 },
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStory.mockResolvedValue(story);
  mockReserve.mockResolvedValue({ reserved: true, run });
  mockClaim.mockResolvedValue({ claimed: true, run });
  mockGetRun.mockResolvedValue(run);
  mockGetBucket.mockResolvedValue({});
  mockReadManifest.mockResolvedValue({
    pages: [
      { number: 5, kind: 'opener', text: 'It began.' },
      { number: 6, kind: 'spread', text: '' },
      { number: 7, kind: 'spread', text: 'The next page.' },
    ],
  });
});

it('requires the internal key before attempting to claim or read the edition', async () => {
  const result = await request(app).post('/plan').send(input);
  expect(result.status).toBe(401);
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockReadManifest).not.toHaveBeenCalled();
});

it('never claims a run reserved for print or ebook generation', async () => {
  mockReserve.mockResolvedValue({
    reserved: false,
    run: { ...run, metadata: { premiumBook: true } },
  });
  const result = await request(app).post('/plan').set('x-api-key', key).send(input);
  expect(result.status).toBe(409);
  expect(mockReserve).toHaveBeenCalledWith(storyId, runId, run.metadata);
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockMarkRunning).not.toHaveBeenCalled();
  expect(mockReadManifest).not.toHaveBeenCalled();
});

it('retains the distinct product run identity when marking claim progress fails', async () => {
  mockUpdateRun.mockRejectedValueOnce(new Error('workflow DB write unavailable'));
  const attempt = await request(app).post('/plan').set('x-api-key', key).send(input);
  expect(attempt.status).toBe(500);
  const failure = await request(app).post('/failed').set('x-api-key', key).send(input);
  expect(failure.status).toBe(200);
  expect(mockUpdateRun).toHaveBeenLastCalledWith(
    runId,
    expect.objectContaining({ status: 'failed' }),
  );
  expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(
    mockClaim.mock.invocationCallOrder[0],
  );
});

it('reports physical narrated pages only after obtaining the edition reservation', async () => {
  mockReturning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ storyId }]);
  const busy = await request(app).post('/plan').set('x-api-key', key).send(input);
  expect(busy.status).toBe(409);
  const resumed = await request(app).post('/plan').set('x-api-key', key).send(input);
  expect(resumed.status).toBe(200);
  expect(resumed.body).toEqual({ claimed: true, pageNumbers: [5, 7] });
});

it('rejects a page when a different execution owns the pending edition narration', async () => {
  mockGetStory.mockResolvedValue({ ...story, audiobookUri: { pendingRunId: 'other-run' } });
  const result = await request(app)
    .post('/page')
    .set('x-api-key', key)
    .send({ ...input, pageNumber: 5 });
  expect(result.status).toBe(409);
  expect(mockSynthesize).not.toHaveBeenCalled();
});

it('reconciles a published audiobook as completed if its workflow observed a terminal write failure', async () => {
  mockGetStory.mockResolvedValue({
    ...story,
    audiobookStatus: 'completed',
    audiobookUri: { runId },
  });
  const response = await request(app).post('/failed').set('x-api-key', key).send(input);
  expect(response.status).toBe(200);
  expect(mockUpdateRun).toHaveBeenCalledWith(
    runId,
    expect.objectContaining({ status: 'completed' }),
  );
  expect(mockSet).not.toHaveBeenCalled();
});
