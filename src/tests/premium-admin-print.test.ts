import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';

const getStory = jest.fn<() => Promise<unknown>>();
const getRun = jest.fn<() => Promise<unknown>>();
const reserveRun = jest.fn<() => Promise<unknown>>();
const updateRun = jest.fn<() => Promise<unknown>>();
const executeWorkflow =
  jest.fn<
    (workflow: string, parameters: { data: { message: { data: string } } }) => Promise<string>
  >();
const listRuns = jest.fn<() => Promise<unknown[]>>();
const updateWhere = jest.fn<() => Promise<unknown[]>>();
const getPackage = jest.fn<() => Promise<unknown>>();
const findFunding = jest.fn<() => Promise<unknown>>();
const renderPackage = jest.fn<() => Promise<unknown>>();

jest.mock('@/services/story.js', () => ({ StoryService: jest.fn(() => ({ getStory })) }));
jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => ({ getRun, reserveRun, updateRun })),
}));
jest.mock('@/adapters/google-cloud/workflows-adapter.js', () => ({
  GoogleCloudWorkflowsAdapter: jest.fn(() => ({ executeWorkflow })),
}));
jest.mock('@/db/workflows-db.js', () => ({
  ...jest.requireActual<typeof import('@/db/workflows-db.js')>('@/db/workflows-db.js'),
  getWorkflowsDatabase: () => ({
    select: () => ({ from: () => ({ where: () => ({ orderBy: listRuns }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: updateWhere }) }) }),
  }),
}));
jest.mock('@/services/premium-self-print.js', () => ({
  ...jest.requireActual<typeof import('@/services/premium-self-print.js')>(
    '@/services/premium-self-print.js',
  ),
  getVerifiedPremiumPrintPackage: getPackage,
  findPremiumSelfPrintFunding: findFunding,
  renderPremiumPrintPackage: renderPackage,
}));

import { premiumAdminPrintRouter } from '@/routes/premium-admin-print.js';
import {
  getAdminPremiumPrintStatus,
  runAdminPremiumPrint,
  signAdminPremiumPrint,
} from '@/services/premium-admin-print.js';

const storyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const selfPrintRun = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const edition = { storyId, revision };
const manifest = {
  key: `${storyId}/premium/revisions/${revision}/manifest.json`,
  generation: '123',
  sha256: 'a'.repeat(64),
  bytes: 100,
};
const source = { ownerId, revision, manifest, generateCMYK: true };
const story = {
  storyId,
  status: 'published',
  authorId: ownerId,
  features: {
    premiumBook: {
      version: 1,
      type: 'premium_children',
      state: 'published',
      audience: 'children_3-6',
      ...source,
    },
  },
};
const selfPrintRecord = {
  storyId,
  runId: selfPrintRun,
  status: 'completed',
  metadata: { premiumSelfPrint: source },
};
const app = express();
app.use(express.json());
app.use('/premium-admin', premiumAdminPrintRouter);

beforeEach(() => {
  jest.resetAllMocks();
  jest.replaceProperty(process, 'env', {
    ...process.env,
    MYTHORIA_ADMIN_API_KEY: 'internal-admin-secret',
  });
  getStory.mockResolvedValue(story);
  getRun.mockResolvedValue(null);
  listRuns.mockResolvedValue([]);
  reserveRun.mockResolvedValue({ reserved: true });
  executeWorkflow.mockResolvedValue('workflow-execution');
});
afterEach(() => jest.restoreAllMocks());

it('requires both service API credentials for Admin PDF access', async () => {
  const status = () => request(app).get(`/premium-admin/${storyId}/${revision}`);
  expect((await status().set('x-admin-api-key', 'internal-admin-secret')).status).toBe(401);
  const workflowKey = process.env.STORY_GENERATION_WORKFLOW_API_KEY ?? '';
  expect((await status().set('x-api-key', workflowKey)).status).toBe(401);
  expect(getStory).not.toHaveBeenCalled();
  const result = await status()
    .set('x-api-key', workflowKey)
    .set('x-admin-api-key', 'internal-admin-secret');
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ status: 'missing' });
});

it('reuses the current completed and funded self-print package without dispatching work', async () => {
  const sign = jest.fn(() => 'signed');
  listRuns.mockResolvedValueOnce([selfPrintRecord]);
  getPackage.mockResolvedValue({ parts: ['interior', 'cover', 'interiorCmyk', 'coverCmyk'], sign });
  findFunding.mockResolvedValue({ status: 'completed' });
  await expect(getAdminPremiumPrintStatus(edition, true)).resolves.toEqual({
    status: 'ready',
    runId: selfPrintRun,
    source: 'self-print',
    parts: ['interior', 'cover', 'interiorCmyk', 'coverCmyk'],
  });
  expect(reserveRun).not.toHaveBeenCalled();
  expect(executeWorkflow).not.toHaveBeenCalled();
  getRun.mockResolvedValueOnce(selfPrintRecord);
  await expect(signAdminPremiumPrint(edition, selfPrintRun, 'coverCmyk')).resolves.toBe('signed');
  expect(sign).toHaveBeenCalledWith('coverCmyk');
  getRun.mockResolvedValueOnce({
    ...selfPrintRecord,
    metadata: { premiumSelfPrint: { ...source, manifest: { ...manifest, generation: '19' } } },
  });
  await expect(signAdminPremiumPrint(edition, selfPrintRun, 'coverCmyk')).resolves.toBeNull();
  expect(sign).toHaveBeenCalledTimes(1);
});

function dispatch(index: number) {
  const [workflow, event] = executeWorkflow.mock.calls[index]!;
  expect(workflow).toBe('print-generation');
  return JSON.parse(Buffer.from(event.data.message.data, 'base64').toString()) as {
    storyId: string;
    revision: string;
    runId: string;
    adminPrintAttempt: string;
  };
}

it('prefers a complete historical package and can fill in missing CMYK', async () => {
  const rgbRun = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const rgbOnly = {
    ...selfPrintRecord,
    runId: rgbRun,
    metadata: { premiumSelfPrint: { ...source, generateCMYK: false } },
  };
  const malformed = { ...selfPrintRecord, metadata: { premiumSelfPrint: { revision } } };
  const rgb = { parts: ['interior', 'cover'] };
  const full = { parts: ['interior', 'cover', 'interiorCmyk', 'coverCmyk'] };
  findFunding.mockResolvedValue({ status: 'completed' });
  listRuns.mockResolvedValueOnce([malformed, rgbOnly, selfPrintRecord]);
  getPackage.mockResolvedValueOnce(rgb).mockResolvedValueOnce(full);
  await expect(getAdminPremiumPrintStatus(edition)).resolves.toMatchObject({
    status: 'ready',
    runId: selfPrintRun,
    parts: full.parts,
  });

  listRuns.mockResolvedValue([rgbOnly]);
  getPackage.mockResolvedValue(rgb);
  await expect(getAdminPremiumPrintStatus(edition)).resolves.toMatchObject({
    status: 'ready',
    runId: rgbRun,
    parts: rgb.parts,
  });
  await expect(getAdminPremiumPrintStatus(edition, true)).resolves.toMatchObject({
    status: 'queued',
  });
  expect(executeWorkflow).toHaveBeenCalledTimes(1);
});

it('deduplicates active requests and uses a new attempt on retry of the pinned run', async () => {
  const submitted = await getAdminPremiumPrintStatus(edition, true);
  expect(submitted.status).toBe('queued');
  const first = dispatch(0);
  const record = {
    storyId,
    runId: first.runId,
    status: 'queued',
    updatedAt: new Date().toISOString(),
    metadata: { premiumAdminPrint: { source, attemptId: first.adminPrintAttempt, renderer: 'v1' } },
  };
  getRun.mockResolvedValueOnce(record);
  await expect(getAdminPremiumPrintStatus(edition, true)).resolves.toEqual(submitted);
  expect(executeWorkflow).toHaveBeenCalledTimes(1);
  getRun.mockResolvedValueOnce({ ...record, status: 'failed' });
  updateWhere.mockResolvedValueOnce([{ runId: first.runId }]);
  await expect(getAdminPremiumPrintStatus(edition, true)).resolves.toEqual(submitted);
  const second = dispatch(1);
  expect(second).toMatchObject({ storyId, revision, runId: first.runId });
  expect(second.adminPrintAttempt).not.toBe(first.adminPrintAttempt);
});

it('fences superseded workers and checks the current revision again before publishing', async () => {
  await getAdminPremiumPrintStatus(edition, true);
  const { runId, adminPrintAttempt } = dispatch(0);
  getRun.mockResolvedValue({
    storyId,
    runId,
    status: 'queued',
    metadata: { premiumAdminPrint: { source, attemptId: adminPrintAttempt, renderer: 'v1' } },
  });
  await expect(runAdminPremiumPrint(edition, runId, selfPrintRun, 'earlier')).rejects.toThrow(
    'no longer current',
  );
  expect(renderPackage).not.toHaveBeenCalled();
  updateWhere.mockResolvedValueOnce([{ runId }]);
  getStory.mockResolvedValueOnce(story).mockResolvedValueOnce({ ...story, status: 'draft' });
  await expect(runAdminPremiumPrint(edition, runId, adminPrintAttempt, 'current')).rejects.toThrow(
    'Published edition not found',
  );
  expect(renderPackage).toHaveBeenCalledWith(storyId, adminPrintAttempt, source, 'admin');
  expect(updateRun).toHaveBeenCalledTimes(1);
  expect(updateRun).toHaveBeenCalledWith(
    runId,
    expect.objectContaining({ status: 'failed', expectedWorkflowExecution: 'current' }),
  );
});
