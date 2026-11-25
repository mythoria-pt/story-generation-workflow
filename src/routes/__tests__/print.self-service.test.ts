import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const storyServiceMock = {
  getStory: jest.fn(),
};

const runsServiceMock = {
  reserveRun: jest.fn(),
  updateRun: jest.fn(),
  getRun: jest.fn(),
  reclaimSelfPrintDispatch: jest.fn(),
  linkSelfPrintExecution: jest.fn(),
};

const workflowsAdapterMock = {
  executeWorkflow: jest.fn(),
};

const sendStoryPrintInstructionsEmailMock = jest.fn();
const renderPremiumSelfPrintMock = jest.fn();
const signPremiumSelfPrintMock = jest.fn();
const selectProductRequestMock = jest.fn();

jest.mock('@/services/premium-self-print.js', () => ({
  ...jest.requireActual<typeof import('@/services/premium-self-print.js')>(
    '@/services/premium-self-print.js',
  ),
  renderPremiumSelfPrint: renderPremiumSelfPrintMock,
  signPremiumSelfPrint: signPremiumSelfPrintMock,
}));

const storyGetStoryMock = storyServiceMock.getStory as jest.Mock;
const runsReserveRunMock = runsServiceMock.reserveRun as jest.Mock;
const runsUpdateRunMock = runsServiceMock.updateRun as jest.Mock;
const runsGetRunMock = runsServiceMock.getRun as jest.Mock;
const workflowsExecuteMock = workflowsAdapterMock.executeWorkflow as jest.Mock;
const sendInstructionsMock = sendStoryPrintInstructionsEmailMock as jest.Mock;

const resolveMock = (mockFn: jest.Mock, value: unknown) => {
  (mockFn as any).mockResolvedValue(value);
};

jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => storyServiceMock),
}));

jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => runsServiceMock),
}));

jest.mock('@/adapters/google-cloud/workflows-adapter.js', () => ({
  GoogleCloudWorkflowsAdapter: jest.fn(() => workflowsAdapterMock),
}));

jest.mock('@/services/notification-client.js', () => ({
  sendStoryCreatedEmail: jest.fn(),
  sendStoryPrintInstructionsEmail: sendStoryPrintInstructionsEmailMock,
}));

jest.mock('@/db/connection.js', () => ({
  getDatabase: jest.fn(() => ({
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: selectProductRequestMock })) })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    })),
  })),
}));

import { printRouter, internalPrintRouter } from '../print';

const app = express();
app.use(express.json());
app.use('/print', printRouter);
app.use('/internal/print', internalPrintRouter);

describe('print routers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storyServiceMock.getStory.mockReset();
    runsServiceMock.reserveRun.mockReset();
    runsServiceMock.updateRun.mockReset();
    runsServiceMock.getRun.mockReset();
    workflowsAdapterMock.executeWorkflow.mockReset();
    sendStoryPrintInstructionsEmailMock.mockReset();
    selectProductRequestMock.mockReset();
    resolveMock(runsServiceMock.reclaimSelfPrintDispatch as jest.Mock, false);
    resolveMock(runsServiceMock.linkSelfPrintExecution as jest.Mock, 'execution-123');
  });

  const premiumStoryId = '00000000-0000-4000-8000-000000000123';
  const premiumRunId = '00000000-0000-4000-8000-000000000999';
  const premiumRevision = '00000000-0000-4000-8000-000000000100';
  const ownerId = '00000000-0000-4000-8000-000000000101';
  const apiKey = process.env.STORY_GENERATION_WORKFLOW_API_KEY || '';
  const pin = {
    version: 1,
    type: 'premium_children',
    state: 'published',
    ownerId,
    audience: 'children_3-6',
    revision: premiumRevision,
    manifest: {
      key: `${premiumStoryId}/premium/revisions/${premiumRevision}/manifest.json`,
      generation: '100',
      bytes: 100,
      sha256: 'a'.repeat(64),
    },
  };
  const premiumSource = {
    ownerId,
    revision: premiumRevision,
    manifest: pin.manifest,
    generateCMYK: true,
  };
  const product = {
    storyId: premiumStoryId,
    authorId: ownerId,
    actionType: 'self_print',
    status: 'pending',
    queueReference: `premium-self-print:v1:${premiumRevision}:100:${pin.manifest.sha256}:100:1`,
  };

  it('reserves the owner’s exact published source before starting the print workflow', async () => {
    const current = '00000000-0000-4000-8000-000000000102';
    resolveMock(selectProductRequestMock as jest.Mock, [product]);
    resolveMock(storyGetStoryMock, {
      storyId: premiumStoryId,
      authorId: ownerId,
      authorEmail: 'owner@example.com',
      status: 'published',
      features: {
        premiumBook: {
          ...pin,
          revision: current,
          manifest: { ...pin.manifest, key: pin.manifest.key.replace(premiumRevision, current) },
        },
      },
    });
    resolveMock(runsReserveRunMock, { reserved: true, run: { status: 'queued' } });
    resolveMock(workflowsExecuteMock, 'execution-123');
    const submit = (premiumBook: unknown, requestedByAuthorId: string) =>
      request(app).post('/print/self-service').send({
        storyId: premiumStoryId,
        workflowId: premiumRunId,
        premiumBook,
        metadata: { requestedByAuthorId },
      });
    await submit({ ...pin, manifest: { ...pin.manifest, generation: '101' } }, ownerId).expect(409);
    await submit(pin, premiumRunId).expect(409);
    expect(runsReserveRunMock).not.toHaveBeenCalled();
    await submit(pin, ownerId).expect(202);
    expect(runsReserveRunMock).toHaveBeenCalledWith(premiumStoryId, premiumRunId, {
      premiumSelfPrint: premiumSource,
      premiumSelfPrintDispatch: expect.objectContaining({ premiumSelfPrint: true }),
      serviceCode: 'selfPrinting',
    });
  });

  it('reclaims an unlinked premium dispatch using its frozen recipient list', async () => {
    const preservedDelivery = { recipients: [{ email: 'original@example.com' }] };
    const reserved = {
      storyId: premiumStoryId,
      runId: premiumRunId,
      status: 'queued',
      metadata: {
        premiumSelfPrint: premiumSource,
        premiumSelfPrintDispatch: {
          premiumSelfPrint: true,
          storyId: premiumStoryId,
          runId: premiumRunId,
          delivery: preservedDelivery,
        },
      },
    };
    resolveMock(storyGetStoryMock, {
      authorId: ownerId,
      authorEmail: 'owner@example.com',
      status: 'published',
      features: { premiumBook: pin },
    });
    resolveMock(selectProductRequestMock as jest.Mock, [product]);
    resolveMock(runsGetRunMock, reserved);
    resolveMock(runsReserveRunMock, { reserved: false, run: reserved });
    resolveMock(workflowsExecuteMock, 'execution-123');
    const retry = () =>
      request(app)
        .post('/print/self-service')
        .send({
          storyId: premiumStoryId,
          workflowId: premiumRunId,
          premiumBook: pin,
          recipientEmail: 'other@example.com',
          metadata: { requestedByAuthorId: ownerId },
        });
    await retry()
      .expect(202)
      .expect(({ body }) => expect(body.executionId).toBe(''));
    expect(workflowsExecuteMock).not.toHaveBeenCalled();
    resolveMock(runsServiceMock.reclaimSelfPrintDispatch as jest.Mock, true);
    await retry()
      .expect(202)
      .expect(({ body }) => expect(body.recipients).toEqual(['original@example.com']));
    const event = workflowsExecuteMock.mock.calls[0]?.[1] as {
      data: { message: { data: string } };
    };
    expect(JSON.parse(Buffer.from(event.data.message.data, 'base64').toString())).toMatchObject({
      delivery: preservedDelivery,
    });
  });

  it('renders from the stored pin and signs only the completed run’s delivery', async () => {
    const printResult = {
      premiumRevision,
      interiorPdfUrl: 'https://storage.googleapis.com/private/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/private/cover.pdf',
    };
    const signedPdfs = {
      interiorPdfUrl: printResult.interiorPdfUrl + '?signed=1',
      coverPdfUrl: printResult.coverPdfUrl + '?signed=2',
    };
    resolveMock(selectProductRequestMock as jest.Mock, [{ ...product, status: 'running' }]);
    const delivery = { recipients: [{ email: 'owner@example.com' }] };
    const run = {
      storyId: premiumStoryId,
      gcpWorkflowExecution: 'premium-execution',
      metadata: {
        premiumSelfPrint: premiumSource,
        premiumSelfPrintDispatch: {
          storyId: premiumStoryId,
          runId: premiumRunId,
          premiumSelfPrint: true,
          delivery,
        },
      },
    };
    resolveMock(runsGetRunMock, { ...run, status: 'running' });
    resolveMock(storyGetStoryMock, {
      storyId: premiumStoryId,
      title: 'A square story',
      features: { premiumBook: pin },
    });
    resolveMock(renderPremiumSelfPrintMock as jest.Mock, printResult);
    resolveMock(signPremiumSelfPrintMock as jest.Mock, signedPdfs);
    resolveMock(sendInstructionsMock, 'sent');

    await request(app)
      .post('/internal/print/generate')
      .set('x-api-key', apiKey)
      .send({
        storyId: premiumStoryId,
        workflowId: premiumRunId,
        executionId: run.gcpWorkflowExecution,
      })
      .expect(200, printResult);
    expect(renderPremiumSelfPrintMock).toHaveBeenCalledWith(
      premiumStoryId,
      premiumRunId,
      premiumSource,
    );
    const notify = (requestedDelivery = delivery) =>
      request(app).post('/internal/print/self-service/notify').set('x-api-key', apiKey).send({
        storyId: premiumStoryId,
        runId: premiumRunId,
        executionId: run.gcpWorkflowExecution,
        delivery: requestedDelivery,
        printResult,
      });
    await notify().expect(409);
    expect(signPremiumSelfPrintMock).not.toHaveBeenCalled();

    resolveMock(runsGetRunMock, { ...run, status: 'completed' });
    await notify({ recipients: [{ email: 'other@example.com' }] }).expect(409);
    expect(signPremiumSelfPrintMock).not.toHaveBeenCalled();
    await notify()
      .expect(200)
      .expect(({ body }) => expect(body.deliveryStatus).toBe('sent'));
    expect(signPremiumSelfPrintMock).toHaveBeenCalledWith(
      premiumStoryId,
      premiumRunId,
      premiumRevision,
    );
    expect(sendInstructionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: premiumRunId,
        premiumRevision,
        pdfs: expect.objectContaining(signedPdfs),
      }),
    );
  });

  it('queues self-print workflow with resolved recipients', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000123',
      authorId: 'author-123',
      title: 'Test Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'en-US',
      storyLanguage: 'en-US',
    });
    resolveMock(runsReserveRunMock, {
      reserved: true,
      run: { status: 'queued', metadata: null },
    });
    resolveMock(workflowsExecuteMock, 'exec-123');

    const response = await request(app).post('/print/self-service').send({
      storyId: '00000000-0000-4000-8000-000000000123',
      workflowId: '00000000-0000-4000-8000-000000000999',
      recipientEmail: 'reader@example.com',
    });

    expect(response.status).toBe(202);
    expect(response.body.success).toBe(true);
    expect(workflowsExecuteMock).toHaveBeenCalled();

    const [, workflowArgs] = workflowsExecuteMock.mock.calls[0];
    const eventArgs = workflowArgs as { data: { message: { data: string } } };
    const payload = JSON.parse(
      Buffer.from(eventArgs.data.message.data, 'base64').toString('utf-8'),
    );
    expect(payload.storyId).toBe('00000000-0000-4000-8000-000000000123');
    expect(payload.runId).toBe('00000000-0000-4000-8000-000000000999');
    expect(payload.origin).toBe('self-service');
    expect(payload.delivery.recipients).toHaveLength(2);
    expect(payload.delivery.recipients[0].email).toBe('owner@example.com');
    expect(payload.delivery.recipients[1].email).toBe('reader@example.com');
    expect(runsUpdateRunMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000999',
      expect.any(Object),
    );
  });

  it('does not start a second workflow for the same reserved workflowId', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000123',
      authorId: 'author-123',
      title: 'Test Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'en-US',
      storyLanguage: 'en-US',
    });
    resolveMock(runsReserveRunMock, {
      reserved: false,
      run: { status: 'queued', gcpWorkflowExecution: 'exec-existing' },
    });

    const response = await request(app).post('/print/self-service').send({
      storyId: '00000000-0000-4000-8000-000000000123',
      workflowId: '00000000-0000-4000-8000-000000000999',
      recipientEmail: 'reader@example.com',
    });

    expect(response.status).toBe(202);
    expect(response.body.executionId).toBe('exec-existing');
    expect(workflowsExecuteMock).not.toHaveBeenCalled();
  });

  it('keeps the request accepted when the workflow started but its execution reference cannot be saved', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000123',
      authorId: 'author-123',
      title: 'Test Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'en-US',
      storyLanguage: 'en-US',
    });
    resolveMock(runsReserveRunMock, {
      reserved: true,
      run: { status: 'queued', metadata: null },
    });
    resolveMock(workflowsExecuteMock, 'exec-123');
    runsUpdateRunMock.mockRejectedValueOnce(new Error('database unavailable') as never);

    const response = await request(app).post('/print/self-service').send({
      storyId: '00000000-0000-4000-8000-000000000123',
      workflowId: '00000000-0000-4000-8000-000000000999',
      recipientEmail: 'reader@example.com',
    });

    expect(response.status).toBe(202);
    expect(response.body.executionId).toBe('exec-123');
    expect(workflowsExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('rejects requests without resolvable recipients', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000456',
      authorId: 'author-456',
      title: 'Untitled',
      authorEmail: null,
      authorPreferredLocale: null,
      storyLanguage: 'en-US',
    });

    const response = await request(app).post('/print/self-service').send({
      storyId: '00000000-0000-4000-8000-000000000456',
      workflowId: '00000000-0000-4000-8000-000000000654',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(workflowsAdapterMock.executeWorkflow).not.toHaveBeenCalled();
  });

  it('invokes notification client for self-service notify endpoint', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000789',
      authorId: 'author-789',
      title: 'My Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'pt-PT',
      storyLanguage: 'pt-PT',
    });
    resolveMock(runsGetRunMock, { gcpWorkflowExecution: 'exec-321' });
    resolveMock(sendInstructionsMock, 'sent');

    const response = await request(app)
      .post('/internal/print/self-service/notify')
      .send({
        storyId: '00000000-0000-4000-8000-000000000789',
        runId: '00000000-0000-4000-8000-000000000987',
        delivery: {
          recipients: [{ email: 'reader@example.com', name: 'Reader' }],
          locale: 'pt-PT',
          metadata: { requestedBy: 'user-1' },
        },
        printResult: {
          interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
          coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
          interiorCmykPdfUrl: null,
          coverCmykPdfUrl: null,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.deliveryStatus).toBe('sent');
    expect(runsUpdateRunMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000987',
      expect.objectContaining({
        metadata: expect.objectContaining({
          serviceCode: 'selfPrinting',
          initiatedBy: 'selfService',
        }),
      }),
    );
    expect(sendStoryPrintInstructionsEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: '00000000-0000-4000-8000-000000000789',
        workflowId: '00000000-0000-4000-8000-000000000987',
        recipient: expect.objectContaining({ email: 'reader@example.com' }),
        pdfs: expect.objectContaining({
          interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
          coverPdfUrl: expect.any(String),
        }),
        metadata: expect.objectContaining({ workflowExecutionId: 'exec-321' }),
      }),
    );
  });

  it('sends extra recipients as cc entries', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000321',
      authorId: 'author-321',
      title: 'Cc Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'en-US',
      storyLanguage: 'en-US',
    });
    resolveMock(runsGetRunMock, { gcpWorkflowExecution: 'exec-cc' });
    resolveMock(sendInstructionsMock, 'sent');

    const response = await request(app)
      .post('/internal/print/self-service/notify')
      .send({
        storyId: '00000000-0000-4000-8000-000000000321',
        runId: '00000000-0000-4000-8000-000000000654',
        delivery: {
          recipients: [
            { email: 'primary@example.com', name: 'Primary' },
            { email: 'second@example.com', name: 'Second' },
          ],
          ccEmails: ['meta@example.com'],
          locale: 'en-US',
        },
        printResult: {
          interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
          coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
          interiorCmykPdfUrl: null,
          coverCmykPdfUrl: null,
        },
      });

    expect(response.status).toBe(200);
    expect(sendStoryPrintInstructionsEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: expect.arrayContaining([
          expect.objectContaining({ email: 'second@example.com' }),
          expect.objectContaining({ email: 'meta@example.com' }),
        ]),
        recipient: expect.objectContaining({ email: 'primary@example.com' }),
      }),
    );
  });

  it('suppresses instructions email for admin-triggered notifications', async () => {
    resolveMock(storyGetStoryMock, {
      storyId: '00000000-0000-4000-8000-000000000555',
      authorId: 'author-555',
      title: 'Admin Story',
      authorEmail: 'owner@example.com',
      authorPreferredLocale: 'en-US',
      storyLanguage: 'en-US',
    });
    resolveMock(runsGetRunMock, { gcpWorkflowExecution: 'exec-admin' });

    const response = await request(app)
      .post('/internal/print/self-service/notify')
      .send({
        storyId: '00000000-0000-4000-8000-000000000555',
        runId: '00000000-0000-4000-8000-000000000999',
        initiatedBy: 'adminPortal',
        delivery: {
          recipients: [{ email: 'reader@example.com', name: 'Reader' }],
          locale: 'en-US',
        },
        printResult: {
          interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
          coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
          interiorCmykPdfUrl: null,
          coverCmykPdfUrl: null,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe('suppressed_for_admin');
    expect(response.body.deliveryStatus).toBe('not_requested');
    expect(sendStoryPrintInstructionsEmailMock).not.toHaveBeenCalled();
    expect(runsUpdateRunMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000999',
      expect.objectContaining({
        metadata: expect.objectContaining({
          serviceCode: 'printGeneration',
          initiatedBy: 'adminPortal',
        }),
      }),
    );
  });
});
