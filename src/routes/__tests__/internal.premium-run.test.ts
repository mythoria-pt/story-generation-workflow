import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const marker = jest.fn<() => Promise<boolean>>();
const verifyClaim = jest.fn();
const claim = jest.fn();
const getRun = jest.fn();
const update = jest.fn();
const terminalState = jest.fn();
const markFailure = jest.fn();
jest.mock('@/config/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/services/runs.js', () => ({
  RunStoryConflictError: class extends Error {},
  RunExecutionConflictError: class extends Error {},
  RunsService: jest.fn(() => ({ claimRun: claim, getRun, updateRun: update })),
}));
jest.mock('@/services/premium-book.js', () => ({
  hasPremiumStoryMarker: marker,
  verifyPremiumClaim: verifyClaim,
  resolvePremiumTerminalStatus: terminalState,
  markPremiumTerminalFailure: markFailure,
}));
jest.mock('@/services/chapters.js', () => ({ ChaptersService: jest.fn() }));
jest.mock('@/services/story.js', () => ({ StoryService: jest.fn() }));
jest.mock('@/services/tts.js', () => ({ TTSService: jest.fn() }));
jest.mock('@/services/progress-tracker.js', () => ({
  ProgressTrackerService: jest.fn(() => ({ updateStoryProgress: jest.fn() })),
}));
jest.mock('@/services/analytics.js', () => ({
  analyticsReconciliationService: {
    markProductRunRunning: jest.fn(),
    recordTerminalRun: jest.fn(),
  },
}));

import { internalRouter } from '../internal';

const app = express();
app.use(express.json(), internalRouter);
const runId = '00000000-0000-4000-8000-000000000001';
const storyId = '00000000-0000-4000-8000-000000000002';
const otherStory = '00000000-0000-4000-8000-000000000003';
const path = `/runs/${runId}`;
const key = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';

beforeEach(() => {
  jest.clearAllMocks();
  marker.mockResolvedValue(true);
  const run = { runId, storyId, status: 'running', gcpWorkflowExecution: 'owner-execution' };
  claim.mockResolvedValue({ claimed: true, run });
  getRun.mockResolvedValue(run);
  update.mockResolvedValue({ ...run, status: 'completed' });
  terminalState.mockResolvedValue('completed');
});

describe('SGW premium run write boundary', () => {
  it('requires authentication and accepted run identity for a premium claim without a queue discriminator', async () => {
    expect((await request(app).post(`${path}/claim`).send({ storyId })).status).toBe(401);
    expect(
      (await request(app).post(`${path}/claim`).set('x-api-key', key).send({ storyId })).status,
    ).toBe(409);
    expect(claim).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .post(`${path}/claim`)
          .set('x-api-key', key)
          .send({ storyId, gcpWorkflowExecution: 'owner-execution' })
      ).status,
    ).toBe(200);
    expect(verifyClaim).toHaveBeenCalledWith(storyId, runId);
    expect(claim).toHaveBeenCalledWith(storyId, runId, 'owner-execution');
  });

  it('rejects unauthorized and stale terminal writes before any run mutation', async () => {
    const body = { status: 'completed', expectedWorkflowExecution: 'owner-execution' };
    expect((await request(app).patch(path).send(body)).status).toBe(401);
    expect(
      (await request(app).patch(path).set('x-api-key', key).send({ status: 'completed' })).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(path)
          .set('x-api-key', key)
          .send({ ...body, storyId: otherStory })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(path)
          .set('x-api-key', key)
          .send({ ...body, expectedWorkflowExecution: 'old' })
      ).status,
    ).toBe(409);
    expect(update).not.toHaveBeenCalled();
    expect((await request(app).patch(path).set('x-api-key', key).send(body)).status).toBe(200);
    expect(update).toHaveBeenCalledWith(runId, expect.objectContaining(body));
  });

  it('retains the legacy claim and update contract for a story without a premium marker', async () => {
    marker.mockResolvedValue(false);
    expect((await request(app).post(`${path}/claim`).send({ storyId })).status).toBe(200);
    expect((await request(app).patch(path).send({ status: 'completed' })).status).toBe(200);
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(terminalState).not.toHaveBeenCalled();
  });
});
