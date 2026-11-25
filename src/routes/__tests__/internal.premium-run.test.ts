import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const marker = jest.fn<() => Promise<boolean>>();
const verifyClaim = jest.fn();
const claim = jest.fn();
const getRun = jest.fn();
const update = jest.fn();
const terminalState = jest.fn();
const markFailure = jest.fn<() => Promise<void>>();
const cleanDrafts = jest.fn<() => Promise<void>>();
const findPrintFunding = jest.fn<() => Promise<unknown>>();
jest.mock('@/services/premium-self-print.js', () => ({
  ...jest.requireActual<typeof import('@/services/premium-self-print.js')>(
    '@/services/premium-self-print.js',
  ),
  findPremiumSelfPrintFunding: findPrintFunding,
}));
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
  cleanPremiumTerminalDrafts: cleanDrafts,
}));
jest.mock('@/services/chapters.js', () => ({ ChaptersService: jest.fn() }));
jest.mock('@/services/story.js', () => ({ StoryService: jest.fn() }));
jest.mock('@/services/tts.js', () => ({ TTSService: jest.fn() }));
jest.mock('@/services/progress-tracker.js', () => ({
  ProgressTrackerService: jest.fn(() => ({ updateStoryProgress: jest.fn() })),
}));
jest.mock('@/services/analytics.js', () => ({
  analyticsReconciliationService: {
    markProductRunRunning: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
  markFailure.mockResolvedValue(undefined);
  cleanDrafts.mockResolvedValue(undefined);
});

describe('SGW premium run write boundary', () => {
  it('protects a reserved self-print execution without applying ebook terminal handlers', async () => {
    const reserved = {
      runId,
      storyId,
      status: 'running',
      gcpWorkflowExecution: 'owner-execution',
      metadata: {
        premiumSelfPrint: {
          ownerId: otherStory,
          revision: storyId,
          manifest: {
            key: 'verified-fixture',
            generation: '1',
            bytes: 100,
            sha256: 'a'.repeat(64),
          },
          generateCMYK: true,
        },
      },
    };
    getRun.mockResolvedValue(reserved);
    const claimCall = (withKey: boolean) =>
      request(app)
        .post(`${path}/claim`)
        .set('x-api-key', withKey ? key : '')
        .send({ storyId, gcpWorkflowExecution: 'owner-execution' });
    await claimCall(false).expect(401);
    findPrintFunding.mockResolvedValueOnce(null);
    await claimCall(true).expect(409);
    findPrintFunding.mockResolvedValueOnce({ status: 'pending' });
    await claimCall(true).expect(200);
    expect(verifyClaim).not.toHaveBeenCalled();
    const complete = { status: 'completed', expectedWorkflowExecution: 'owner-execution', storyId };
    await request(app).patch(path).send(complete).expect(401);
    await request(app)
      .patch(path)
      .set('x-api-key', key)
      .send({ ...complete, metadata: { premiumSelfPrintDispatch: {} } })
      .expect(409);
    await request(app).patch(path).set('x-api-key', key).send(complete).expect(200);
    expect(terminalState).not.toHaveBeenCalled();
    expect(cleanDrafts).not.toHaveBeenCalled();
  });

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
    expect(cleanDrafts).not.toHaveBeenCalled();
    expect((await request(app).patch(path).set('x-api-key', key).send(body)).status).toBe(200);
    expect(update).toHaveBeenCalledWith(runId, expect.objectContaining(body));
    expect(cleanDrafts).toHaveBeenCalledWith(storyId, runId, 'owner-execution');
    expect(cleanDrafts.mock.invocationCallOrder[0]).toBeGreaterThan(
      update.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['failed', 'blocked', 'cancelled'] as const)(
    'keeps draft retention tied to the durable %s outcome',
    async (status) => {
      terminalState.mockResolvedValue(status);
      update.mockResolvedValue({ runId, storyId, status, gcpWorkflowExecution: 'owner-execution' });
      const response = await request(app)
        .patch(path)
        .set('x-api-key', key)
        .send({ status, expectedWorkflowExecution: 'owner-execution' });
      expect(response.status).toBe(200);
      if (status === 'cancelled') {
        expect(cleanDrafts).toHaveBeenCalledWith(storyId, runId, 'owner-execution');
        expect(markFailure).not.toHaveBeenCalled();
      } else {
        expect(cleanDrafts).not.toHaveBeenCalled();
        expect(markFailure).toHaveBeenCalledWith(storyId, runId, 'owner-execution');
      }
    },
  );

  it('retains the legacy claim and update contract for a story without a premium marker', async () => {
    marker.mockResolvedValue(false);
    expect((await request(app).post(`${path}/claim`).send({ storyId })).status).toBe(200);
    expect((await request(app).patch(path).send({ status: 'completed' })).status).toBe(200);
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(terminalState).not.toHaveBeenCalled();
    expect(cleanDrafts).not.toHaveBeenCalled();
  });
});
