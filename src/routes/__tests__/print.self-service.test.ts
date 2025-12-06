import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const storyServiceMock = {
  getStory: jest.fn(),
};

const runsServiceMock = {
  createOrGetRun: jest.fn(),
  updateRun: jest.fn(),
  getRun: jest.fn(),
};

const workflowsAdapterMock = {
  executeWorkflow: jest.fn(),
};

const sendStoryPrintInstructionsEmailMock = jest.fn();

const storyGetStoryMock = storyServiceMock.getStory as jest.Mock;
const runsCreateOrGetRunMock = runsServiceMock.createOrGetRun as jest.Mock;
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

import { printRouter, internalPrintRouter } from '../print';

const app = express();
app.use(express.json());
app.use('/print', printRouter);
app.use('/internal/print', internalPrintRouter);

describe('print routers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storyServiceMock.getStory.mockReset();
    runsServiceMock.createOrGetRun.mockReset();
    runsServiceMock.updateRun.mockReset();
    runsServiceMock.getRun.mockReset();
    workflowsAdapterMock.executeWorkflow.mockReset();
    sendStoryPrintInstructionsEmailMock.mockReset();
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
    resolveMock(runsCreateOrGetRunMock, { metadata: null });
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
    resolveMock(sendInstructionsMock, true);

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
        pdfs: expect.objectContaining({ coverPdfUrl: expect.any(String) }),
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
    resolveMock(sendInstructionsMock, true);

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
