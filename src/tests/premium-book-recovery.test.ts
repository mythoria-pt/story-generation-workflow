import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableName, type Table } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { RunsService } from '@/services/runs.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import {
  claimPremiumResume,
  identifyPremiumRun,
  markPremiumTerminalFailure,
  resumePremiumRun,
  resolvePremiumTerminalStatus,
} from '@/services/premium-book.js';
import { premiumManifestFixture } from './fixtures/premium-book.js';

jest.mock('@/db/connection.js', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/runs.js', () => ({ RunsService: jest.fn() }));
jest.mock('@/adapters/google-cloud/workflows-adapter.js', () => ({
  GoogleCloudWorkflowsAdapter: jest.fn(),
}));

const fixture = premiumManifestFixture();
const { storyId, ownerId, revision: runId } = fixture;
const queued = {
  version: 1,
  type: 'premium_children',
  state: 'queued',
  revision: runId,
  ownerId,
  audience: 'children_0-2',
};

function setup() {
  const events: string[] = [];
  const story = {
    storyId,
    authorId: ownerId,
    ownerId,
    status: 'writing',
    features: { premiumBook: queued },
  };
  const request = { storyId, ownerId, status: 'published', compensatedAt: null as Date | null };
  const run = {
    storyId,
    status: 'running',
    gcpWorkflowExecution: 'old',
    updatedAt: 'initial-timestamp',
  };
  const runMock = {
    getRun: jest.fn(async () => run),
    updateRun: jest.fn(),
    claimPremiumResume: jest.fn(async () => run),
  };
  const cloud = {
    getWorkflowExecution: jest.fn(async () => ({ status: 'running' })),
    executeWorkflow: jest.fn(async (_name: string, _argument: unknown) => 'new-execution'),
  };
  const query = (table: Table) => {
    const name = getTableName(table);
    const rows = () => (name === 'stories' ? [story] : [request]);
    return {
      where: () =>
        Object.assign(Promise.resolve(rows()), {
          for: async () => {
            events.push(`lock ${name}`);
            return rows();
          },
        }),
    };
  };
  const tx = {
    select: () => ({ from: query }),
    update: (table: Table) => ({
      set: (data: { status?: string; storyGenerationStatus?: string }) => ({
        where: async () => {
          const name = getTableName(table);
          events.push(`write ${name}: ${data.storyGenerationStatus ?? data.status}`);
        },
      }),
    }),
  };
  (getDatabase as jest.Mock).mockReturnValue({
    ...tx,
    transaction: async (work: (database: typeof tx) => Promise<void>) => work(tx),
  });
  (RunsService as jest.Mock).mockImplementation(() => runMock);
  (GoogleCloudWorkflowsAdapter as jest.Mock).mockImplementation(() => cloud);
  return { story, request, run, runMock, cloud, events };
}

beforeEach(() => jest.clearAllMocks());

describe('premium accepted run and recovery', () => {
  it('locks story then accepted request before the first premium provider stage', async () => {
    const { events } = setup();
    expect(await identifyPremiumRun(storyId, runId, 'old')).toMatchObject({ premium: true });
    expect(events).toEqual([
      'lock stories',
      'lock story_generation_requests',
      'write stories: running',
    ]);
  });

  it('stops when queue compensation wins the lock', async () => {
    const { request, story, events } = setup();
    const recovered = story.features;
    Object.defineProperty(story, 'features', {
      get: () =>
        events.includes('lock stories')
          ? { premiumBook: { ...queued, state: 'draft' } }
          : recovered,
    });
    request.compensatedAt = null;
    await expect(identifyPremiumRun(storyId, runId, 'old')).rejects.toMatchObject({
      code: 'premium_identity',
    });
    expect(events).toEqual(['lock stories']);
  });

  it('dispatches the accepted run without changing its identity and rejects stale resume deliveries', async () => {
    const { run, runMock, cloud, events } = setup();
    run.status = 'failed';
    expect(await resumePremiumRun(storyId, runId)).toEqual({
      storyId,
      runId,
      executionId: 'new-execution',
    });
    const call = cloud.executeWorkflow.mock.calls[0];
    const event = call?.[1] as { data: { message: { data: string } } };
    const payload = JSON.parse(Buffer.from(event.data.message.data, 'base64').toString());
    expect(payload).toEqual({
      storyId,
      runId,
      bookType: 'premium_children',
      resumeUpdatedAt: run.updatedAt,
    });
    expect(events).toEqual([]);
    expect(await claimPremiumResume(storyId, runId, run.updatedAt, 'new-execution')).toEqual({
      claimed: true,
    });
    expect(events).toEqual([
      'lock stories',
      'lock story_generation_requests',
      'write story_generation_requests: published',
      'write stories: running',
    ]);
    run.status = 'running';
    run.updatedAt = 'later-timestamp';
    run.gcpWorkflowExecution = 'new-execution';
    expect(
      await claimPremiumResume(storyId, runId, 'initial-timestamp', 'other-execution'),
    ).toEqual({ claimed: false });
    expect(runMock.claimPremiumResume).toHaveBeenCalledTimes(1);
    expect(cloud.getWorkflowExecution).not.toHaveBeenCalled();
  });

  it('prevents completion before publication and leaves a blocked run recoverable', async () => {
    const { events, run } = setup();
    await expect(resolvePremiumTerminalStatus(storyId, runId, 'completed')).rejects.toMatchObject({
      code: 'premium_unpublished',
    });
    expect(await resolvePremiumTerminalStatus(storyId, runId, 'blocked')).toBe('blocked');
    expect(events).toEqual([]);
    run.status = 'blocked';
    await markPremiumTerminalFailure(storyId, runId, 'old');
    expect(events).toEqual(['lock stories', 'write stories: failed']);
    run.status = 'running';
    run.gcpWorkflowExecution = 'new-execution';
    await markPremiumTerminalFailure(storyId, runId, 'old');
    expect(events).toEqual(['lock stories', 'write stories: failed', 'lock stories']);
  });
});
