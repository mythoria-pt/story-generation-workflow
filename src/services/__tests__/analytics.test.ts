import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/db/connection', () => ({ getDatabase: jest.fn() }));
jest.mock('@/db/workflows-db', () => ({ getWorkflowsDatabase: jest.fn() }));

import { logger } from '@/config/logger';
import { getDatabase } from '@/db/connection';
import { getWorkflowsDatabase } from '@/db/workflows-db';
import { AnalyticsReconciliationService } from '../analytics';

const terminalRun = {
  runId: 'run-1',
  storyId: 'story-1',
  status: 'failed' as const,
  currentStep: 'Generate Chapters',
  errorMessage: 'Unauthorized token for child@example.com',
  startedAt: '2026-07-17T00:00:00.000Z',
  endedAt: '2026-07-17T00:01:30.000Z',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:01:30.000Z',
  gcpWorkflowExecution: null,
  metadata: null,
};

const trackedRequest = {
  runId: 'run-1',
  storyId: 'story-1',
  authorId: 'author-1',
  creditsSpent: 3,
  clientId: '123.456',
  sessionId: 123,
  consent: {
    analyticsStorage: 'granted',
    adUserData: 'denied',
    adPersonalization: 'denied',
  },
};

const requestedEvent = {
  userId: 'clerk-1',
  params: { primary_intent: 'romance' },
};

describe('AnalyticsReconciliationService', () => {
  let sharedDb: any;
  let workflowsDb: any;
  let insertValues: jest.Mock;
  let updateSet: jest.Mock;
  let recordRequestRows: any[];
  let requestedEventRows: any[];
  let reconciliationRequestRows: Array<{ runId: string }>;
  let workflowRows: any[];
  let insertedOutboxRows: any[];

  beforeEach(() => {
    recordRequestRows = [trackedRequest];
    requestedEventRows = [requestedEvent];
    reconciliationRequestRows = [];
    workflowRows = [];
    insertedOutboxRows = [{ outboxId: 'outbox-1' }];
    insertValues = jest.fn(() => ({
      onConflictDoNothing: jest.fn(() => ({
        returning: jest.fn().mockImplementation(async () => insertedOutboxRows),
      })),
    }));
    updateSet = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
    const tx = {
      insert: jest.fn(() => ({ values: insertValues })),
      update: jest.fn(() => ({ set: updateSet })),
    };

    sharedDb = {
      select: jest.fn((selection?: Record<string, unknown>) => {
        if (selection && 'userId' in selection) {
          return {
            from: jest.fn(() => ({
              where: jest.fn().mockImplementation(async () => requestedEventRows),
            })),
          };
        }
        if (selection) {
          return {
            from: jest.fn(() => ({
              where: jest.fn(() => ({
                orderBy: jest.fn(() => ({
                  limit: jest.fn().mockImplementation(async () => reconciliationRequestRows),
                })),
              })),
            })),
          };
        }
        return {
          from: jest.fn(() => ({
            where: jest.fn().mockImplementation(async () => recordRequestRows),
          })),
        };
      }),
      transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    workflowsDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockImplementation(async () => workflowRows),
        })),
      })),
    };

    (getDatabase as jest.Mock).mockReturnValue(sharedDb);
    (getWorkflowsDatabase as jest.Mock).mockReturnValue(workflowsDb);
    jest.clearAllMocks();
  });

  it('writes one sanitized terminal event and updates the shared request', async () => {
    const service = new AnalyticsReconciliationService();
    const result = await service.recordTerminalRun(terminalRun);

    expect(result).toBe('recorded');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'story_generation_failed:run-1',
        eventName: 'story_generation_failed',
        authorId: 'author-1',
        userId: 'clerk-1',
        params: expect.objectContaining({
          duration_seconds: 90,
          primary_intent: 'romance',
          failure_stage: 'generate_chapters',
          failure_code: 'auth_error',
        }),
      }),
    );
    expect(JSON.stringify(insertValues.mock.calls)).not.toContain('child@example.com');
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', terminalAt: new Date('2026-07-17T00:01:30Z') }),
    );
  });

  it('records the canonical completion event with a stable idempotency key', async () => {
    const service = new AnalyticsReconciliationService();

    await expect(
      service.recordTerminalRun({ ...terminalRun, status: 'completed', errorMessage: null }),
    ).resolves.toBe('recorded');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'story_generation_completed:run-1',
        eventName: 'story_generation_completed',
        userId: 'clerk-1',
        params: expect.objectContaining({ primary_intent: 'romance' }),
      }),
    );
  });

  it('treats a direct terminal update with no shared request as untracked', async () => {
    recordRequestRows = [];
    const service = new AnalyticsReconciliationService();

    await expect(service.recordTerminalRun(terminalRun)).resolves.toBe('untracked');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Terminal run is not tracked for analytics',
      expect.objectContaining({ runRef: expect.any(String) }),
    );
    expect(sharedDb.transaction).not.toHaveBeenCalled();
  });

  it('reconciles terminal runs only for published non-terminal shared requests', async () => {
    reconciliationRequestRows = [{ runId: 'run-1' }, { runId: 'run-2' }];
    workflowRows = [terminalRun];
    const service = new AnalyticsReconciliationService();

    await expect(service.reconcileRecentTerminalRuns()).resolves.toEqual({
      inspected: 2,
      recorded: 1,
      deferredContext: 0,
      duplicates: 0,
      notEligible: 0,
      untracked: 0,
    });
    expect(workflowsDb.select).toHaveBeenCalledTimes(1);
    expect(sharedDb.transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves active workflow runs pending without warning', async () => {
    reconciliationRequestRows = [{ runId: 'run-active' }];
    workflowRows = [];
    const service = new AnalyticsReconciliationService();

    await expect(service.reconcileRecentTerminalRuns()).resolves.toEqual({
      inspected: 1,
      recorded: 0,
      deferredContext: 0,
      duplicates: 0,
      notEligible: 0,
      untracked: 0,
    });
    expect(sharedDb.transaction).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not query the workflow database when no eligible requests exist', async () => {
    const service = new AnalyticsReconciliationService();

    await expect(service.reconcileRecentTerminalRuns()).resolves.toEqual({
      inspected: 0,
      recorded: 0,
      deferredContext: 0,
      duplicates: 0,
      notEligible: 0,
      untracked: 0,
    });
    expect(workflowsDb.select).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('creates a recoverable terminal event when consent exists without a client id', async () => {
    recordRequestRows = [{ ...trackedRequest, clientId: null, sessionId: null }];
    const service = new AnalyticsReconciliationService();

    await expect(service.recordTerminalRun(terminalRun)).resolves.toBe('deferred_context');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'author-1',
        clientId: null,
        consent: trackedRequest.consent,
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', terminalAt: expect.any(Date) }),
    );
  });

  it('marks an explicitly non-consented terminal run as not eligible without an outbox row', async () => {
    recordRequestRows = [{ ...trackedRequest, clientId: null, consent: null }];
    const service = new AnalyticsReconciliationService();

    await expect(service.recordTerminalRun(terminalRun)).resolves.toBe('not_eligible');
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', terminalAt: expect.any(Date) }),
    );
  });

  it('reports an idempotent terminal event conflict as a duplicate', async () => {
    insertedOutboxRows = [];
    const service = new AnalyticsReconciliationService();

    await expect(service.recordTerminalRun(terminalRun)).resolves.toBe('duplicate');
  });
});
