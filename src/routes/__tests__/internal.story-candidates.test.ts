import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const list = jest.fn();
const get = jest.fn();
jest.mock('@/config/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/services/runs.js', () => ({
  RunStoryConflictError: class extends Error {},
  RunsService: jest.fn(() => ({ listStoryCreatedCandidates: list, getStoryCreatedCandidate: get })),
}));
jest.mock('@/services/chapters.js', () => ({
  ChaptersService: jest.fn(() => ({})),
  ChapterNotPersistedError: class extends Error {},
}));
jest.mock('@/services/story.js', () => ({ StoryService: jest.fn(() => ({})) }));
jest.mock('@/services/tts.js', () => ({ TTSService: jest.fn(() => ({})) }));
jest.mock('@/services/progress-tracker.js', () => ({
  ProgressTrackerService: jest.fn(() => ({})),
}));
jest.mock('@/services/analytics.js', () => ({ analyticsReconciliationService: {} }));
import { internalRouter } from '../internal';
const app = express();
app.use('/internal', internalRouter);
const path = '/internal/notifications/story-created-candidates';
const key = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';
const runId = '00000000-0000-4000-8000-000000000001';

describe('story notification candidates', () => {
  it('requires an API key for both routes', async () => {
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(`${path}/${runId}`)).status).toBe(401);
  });
  it('retains window and precise cursor position even across an empty page', async () => {
    list.mockResolvedValueOnce({
      candidates: [],
      after: { completedAt: '2026-10-31 12:00:00.123456+00', runId },
    });
    list.mockResolvedValueOnce({ candidates: [], after: null });
    const first = await request(app)
      .get(path)
      .set('x-api-key', key)
      .query({ from: '2026-10-30T00:00:00Z', to: '2026-11-01T00:00:00Z', limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app)
      .get(path)
      .set('x-api-key', key)
      .query({ cursor: first.body.nextCursor, limit: 1 });
    expect(second.status).toBe(200);
    expect(second.body.nextCursor).toBeNull();
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: '2026-10-30T00:00:00Z',
        after: { completedAt: '2026-10-31 12:00:00.123456+00', runId },
      }),
    );
    expect(
      (
        await request(app)
          .get(path)
          .set('x-api-key', key)
          .query({ cursor: first.body.nextCursor, from: '2026-10-31T00:00:00Z' })
      ).status,
    ).toBe(400);
  });
  it('validates limits and identifies eligible runs', async () => {
    expect((await request(app).get(path).set('x-api-key', key).query({ limit: 101 })).status).toBe(
      400,
    );
    get.mockResolvedValueOnce({ runId, storyId: runId, completedAt: '2026-11-01T00:00:00.000Z' });
    expect((await request(app).get(`${path}/${runId}`).set('x-api-key', key)).body.runId).toBe(
      runId,
    );
    get.mockResolvedValueOnce(null);
    expect((await request(app).get(`${path}/${runId}`).set('x-api-key', key)).status).toBe(404);
  });
});
