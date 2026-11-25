import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

const mockGetStory = jest.fn();
const mockReserve = jest.fn();
const mockClaim = jest.fn();
const mockGetRun = jest.fn();
const mockUpdateRun = jest.fn();
const mockMarkRunning = jest.fn();
const mockRecordTerminal = jest.fn();
const mockGetBucket = jest.fn();
const mockReadManifest = jest.fn();
const mockReadCheckpoint = jest.fn();
const mockReadObject = jest.fn();
const mockSaveObject = jest.fn();
const mockDeleteObject = jest.fn();
const mockStageCheckpoint = jest.fn((_bucket, _key, _schema, make: () => Promise<unknown>) =>
  make(),
);
const mockConcatenate = jest.fn();
const mockMeasureDuration = jest.fn();
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
  premiumDigest: (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex'),
  readPremiumCheckpoint: mockReadCheckpoint,
  readPremiumManifest: mockReadManifest,
  readPremiumObject: mockReadObject,
  savePremiumObject: mockSaveObject,
  stagePremiumCheckpoint: mockStageCheckpoint,
  withPremiumLease: (_bucket: unknown, _key: string, action: () => Promise<unknown>) => action(),
}));
jest.mock('@/services/audio-concatenation.js', () => ({
  concatenateAudioBuffers: mockConcatenate,
  measureAudioDurationSeconds: mockMeasureDuration,
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
const prefix = `${storyId}/premium/revisions/${revision}/audiobooks/${runId}`;
const audioBytes = Buffer.from('continuous narration');
const digest = createHash('sha256').update(audioBytes).digest('hex');
const audiobookFile = {
  key: `${prefix}/audiobook-${digest}.mp3`,
  generation: '17',
  sha256: digest,
  bytes: audioBytes.length,
};
const publication = {
  type: 'premium_children',
  revision,
  runId,
  audio: audiobookFile,
  duration: 12,
};
const pageAudio = (pageNumber: number) => ({
  pageNumber,
  duration: 6,
  audio: { ...audiobookFile, key: `${prefix}/page-${pageNumber}-${digest}.mp3` },
});
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
  mockGetBucket.mockResolvedValue({ file: () => ({ delete: mockDeleteObject }) });
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

it('publishes one assembled file in narrative order and cleans up private page files after publication', async () => {
  const opener = Buffer.from('opener');
  const spread = Buffer.from('spread');
  mockGetStory.mockResolvedValue({ ...story, audiobookUri: { pendingRunId: runId } });
  mockReadCheckpoint.mockImplementation(async (_bucket, path: string) =>
    pageAudio(path.endsWith('page-5.json') ? 5 : 7),
  );
  mockReadObject.mockImplementation(async (_bucket, asset: typeof audiobookFile) => {
    if (asset.key === audiobookFile.key) return audioBytes;
    return asset.key.includes('/page-5-') ? opener : spread;
  });
  mockConcatenate.mockResolvedValue({ buffer: audioBytes });
  mockMeasureDuration.mockResolvedValue(12);
  mockSaveObject.mockResolvedValue(audiobookFile);
  mockReturning.mockResolvedValue([{ storyId }]);

  const response = await request(app).post('/complete').set('x-api-key', key).send(input);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true, totalDuration: 12, pagesProcessed: 2 });
  expect(mockConcatenate).toHaveBeenCalledWith([opener, spread], { normalizeStreams: true });
  expect(mockSaveObject).toHaveBeenCalledTimes(1);
  expect(mockSaveObject).toHaveBeenCalledWith(
    expect.anything(),
    audiobookFile.key,
    audioBytes,
    'audio/mpeg',
  );
  expect(mockSet).toHaveBeenCalledWith(
    expect.objectContaining({
      audiobookStatus: 'completed',
      hasAudio: true,
      audiobookUri: publication,
    }),
  );
  expect(mockDeleteObject).toHaveBeenCalledTimes(2);
  expect(mockDeleteObject).toHaveBeenCalledWith({ ifGenerationMatch: '17', ignoreNotFound: true });
  expect(mockReturning.mock.invocationCallOrder[0]).toBeLessThan(
    mockDeleteObject.mock.invocationCallOrder[0],
  );
});

it('leaves an incomplete book unpublished and retains its page checkpoints', async () => {
  mockGetStory.mockResolvedValue({ ...story, audiobookUri: { pendingRunId: runId } });
  mockReadCheckpoint.mockResolvedValue(undefined);

  const response = await request(app).post('/complete').set('x-api-key', key).send(input);

  expect(response.status).toBe(409);
  expect(mockConcatenate).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
  expect(mockDeleteObject).not.toHaveBeenCalled();
});

it('supports full-file byte ranges and exposes only source zero for new recordings', async () => {
  mockGetStory.mockResolvedValue({ ...story, audiobookUri: publication });
  mockReadObject.mockResolvedValue(audioBytes);
  const url = `/${storyId}/${runId}`;

  const response = await request(app)
    .get(`${url}/0`)
    .set('x-api-key', key)
    .set('range', 'bytes=0-9')
    .buffer(true);

  expect(response.status).toBe(206);
  expect(response.headers['content-range']).toBe(`bytes 0-9/${audioBytes.length}`);
  expect(response.headers['content-type']).toBe('audio/mpeg');
  expect(mockReadObject).toHaveBeenCalledWith(expect.anything(), audiobookFile);
  const nonexistent = await request(app).get(`${url}/1`).set('x-api-key', key);
  expect(nonexistent.status).toBe(404);
});

it('continues to serve legacy page recordings from the same edition and run', async () => {
  const secondTrack = pageAudio(7);
  mockGetStory.mockResolvedValue({
    ...story,
    audiobookUri: {
      type: 'premium_children',
      revision,
      runId,
      tracks: [pageAudio(5), secondTrack],
    },
  });
  mockReadObject.mockResolvedValue(audioBytes);

  const response = await request(app).get(`/${storyId}/${runId}/1`).set('x-api-key', key);

  expect(response.status).toBe(200);
  expect(mockReadObject).toHaveBeenCalledWith(expect.anything(), secondTrack.audio);
});
