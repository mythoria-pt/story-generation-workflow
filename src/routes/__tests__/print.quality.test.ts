import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const storyServiceMock = {
  getStory: jest.fn(),
  getStoryForPrint: jest.fn(),
  updateStoryPrintUrls: jest.fn(),
};

const runsServiceMock = {
  createOrGetRun: jest.fn(),
  updateRun: jest.fn(),
  getRun: jest.fn(),
};

const workflowsAdapterMock = {
  executeWorkflow: jest.fn(),
};

const printGenerationHandlerMock = {
  execute: jest.fn(),
};

const printQualityServiceMock = {
  execute: jest.fn(),
};

const mythoriaAdminClientMock = {
  getManagers: jest.fn(),
};

const sendPrintQaCriticalEmailMock = jest.fn();

jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => storyServiceMock),
}));

jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => runsServiceMock),
}));

jest.mock('@/adapters/google-cloud/workflows-adapter.js', () => ({
  GoogleCloudWorkflowsAdapter: jest.fn(() => workflowsAdapterMock),
}));

jest.mock('@/workflows/handlers.js', () => ({
  PrintGenerationHandler: jest.fn(() => printGenerationHandlerMock),
}));

jest.mock('@/services/print-quality.js', () => ({
  PrintQualityService: jest.fn(() => printQualityServiceMock),
}));

jest.mock('@/services/mythoria-admin-client.js', () => ({
  MythoriaAdminClient: jest.fn(() => mythoriaAdminClientMock),
}));

jest.mock('@/services/notification-client.js', () => ({
  sendStoryCreatedEmail: jest.fn(),
  sendStoryPrintInstructionsEmail: jest.fn(),
  sendPrintQaCriticalEmail: sendPrintQaCriticalEmailMock,
}));

import { internalPrintRouter } from '../print';

const app = express();
app.use(express.json());
app.use('/internal/print', internalPrintRouter);

describe('print quality routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storyServiceMock.getStory.mockReset();
    printQualityServiceMock.execute.mockReset();
    mythoriaAdminClientMock.getManagers.mockReset();
    sendPrintQaCriticalEmailMock.mockReset();
  });

  it('returns a passing QA report', async () => {
    printQualityServiceMock.execute.mockResolvedValue({
      qaStatus: 'passed',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      passCount: 6,
      warningCount: 0,
      criticalCount: 0,
      alertNeeded: false,
      fixesApplied: [],
      criticalErrors: [],
      warnings: [],
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
        interiorCmykPdfUrl: null,
        coverCmykPdfUrl: null,
      },
    });

    const response = await request(app).post('/internal/print/quality-check').send({
      storyId: '00000000-0000-4000-8000-000000000101',
      runId: '00000000-0000-4000-8000-000000000102',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.qaStatus).toBe('passed');
    expect(printQualityServiceMock.execute).toHaveBeenCalled();
  });

  it('returns passed_with_fixes when QA auto-fix succeeds', async () => {
    printQualityServiceMock.execute.mockResolvedValue({
      qaStatus: 'passed_with_fixes',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      passCount: 7,
      warningCount: 1,
      criticalCount: 0,
      alertNeeded: false,
      fixesApplied: [
        {
          chapterNumber: 4,
          strategy: 'tighten-chapter-spacing-soft',
          layoutOverride: {
            marginLeftMM: 20.25,
            marginRightMM: 20.25,
          },
        },
      ],
      criticalErrors: [],
      warnings: [],
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
        interiorCmykPdfUrl: 'https://storage.googleapis.com/bucket/interior_cmyk.pdf',
        coverCmykPdfUrl: 'https://storage.googleapis.com/bucket/cover_cmyk.pdf',
      },
    });

    const response = await request(app).post('/internal/print/quality-check').send({
      storyId: '00000000-0000-4000-8000-000000000201',
      runId: '00000000-0000-4000-8000-000000000202',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
        interiorCmykPdfUrl: 'https://storage.googleapis.com/bucket/interior_cmyk.pdf',
        coverCmykPdfUrl: 'https://storage.googleapis.com/bucket/cover_cmyk.pdf',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.qaStatus).toBe('passed_with_fixes');
    expect(response.body.fixesApplied).toHaveLength(1);
  });

  it('returns critical issues without failing the route', async () => {
    printQualityServiceMock.execute.mockResolvedValue({
      qaStatus: 'critical_issues_remaining',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      passCount: 3,
      warningCount: 1,
      criticalCount: 2,
      alertNeeded: true,
      fixesApplied: [],
      criticalErrors: [
        {
          code: 'chapter_sparse_last_page',
          severity: 'critical',
          message: 'Chapter 6 ends on an almost empty page.',
        },
      ],
      warnings: [],
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
        interiorCmykPdfUrl: null,
        coverCmykPdfUrl: null,
      },
    });

    const response = await request(app).post('/internal/print/quality-check').send({
      storyId: '00000000-0000-4000-8000-000000000301',
      runId: '00000000-0000-4000-8000-000000000302',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.alertNeeded).toBe(true);
    expect(response.body.criticalCount).toBe(2);
  });

  it('returns sent false when no admin recipients are available', async () => {
    storyServiceMock.getStory.mockResolvedValue({
      storyId: '00000000-0000-4000-8000-000000000401',
      title: 'Admin Alert Story',
    });
    mythoriaAdminClientMock.getManagers.mockResolvedValue([]);

    const response = await request(app).post('/internal/print/quality-alert').send({
      storyId: '00000000-0000-4000-8000-000000000401',
      runId: '00000000-0000-4000-8000-000000000402',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      },
      criticalErrors: [
        {
          code: 'chapter_sparse_last_page',
          severity: 'critical',
          message: 'Chapter 4 ends on an almost empty page.',
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(false);
    expect(response.body.reason).toBe('no_recipients');
    expect(sendPrintQaCriticalEmailMock).not.toHaveBeenCalled();
  });

  it('returns sent false when notification delivery fails', async () => {
    storyServiceMock.getStory.mockResolvedValue({
      storyId: '00000000-0000-4000-8000-000000000501',
      title: 'Admin Alert Story',
    });
    mythoriaAdminClientMock.getManagers.mockResolvedValue([
      {
        managerId: 'manager-1',
        name: 'Admin One',
        email: 'admin1@example.com',
      },
    ]);
    sendPrintQaCriticalEmailMock.mockResolvedValue(false);

    const response = await request(app).post('/internal/print/quality-alert').send({
      storyId: '00000000-0000-4000-8000-000000000501',
      runId: '00000000-0000-4000-8000-000000000502',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      },
      criticalErrors: [
        {
          code: 'chapter_sparse_last_page',
          severity: 'critical',
          message: 'Chapter 4 ends on an almost empty page.',
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(false);
    expect(response.body.recipientCount).toBe(1);
  });

  it('dispatches the admin alert when recipients and notification delivery succeed', async () => {
    storyServiceMock.getStory.mockResolvedValue({
      storyId: '00000000-0000-4000-8000-000000000601',
      title: 'Admin Alert Story',
    });
    mythoriaAdminClientMock.getManagers.mockResolvedValue([
      {
        managerId: 'manager-1',
        name: 'Admin One',
        email: 'admin1@example.com',
      },
      {
        managerId: 'manager-2',
        name: 'Admin Two',
        email: 'admin2@example.com',
      },
    ]);
    sendPrintQaCriticalEmailMock.mockResolvedValue(true);

    const response = await request(app).post('/internal/print/quality-alert').send({
      storyId: '00000000-0000-4000-8000-000000000601',
      runId: '00000000-0000-4000-8000-000000000602',
      reportUrl: 'https://storage.googleapis.com/bucket/report.json',
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      },
      criticalErrors: [
        {
          code: 'cover_title_missing',
          severity: 'critical',
          message: 'The front cover title is not clearly visible.',
        },
      ],
      fixesApplied: [
        {
          chapterNumber: 4,
          strategy: 'tighten-chapter-spacing-soft',
          layoutOverride: {
            marginLeftMM: 20.25,
            marginRightMM: 20.25,
          },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(true);
    expect(response.body.recipientCount).toBe(2);
    expect(sendPrintQaCriticalEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: '00000000-0000-4000-8000-000000000601',
        runId: '00000000-0000-4000-8000-000000000602',
      }),
    );
  });
});
