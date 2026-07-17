import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/db/connection', () => ({ getDatabase: jest.fn() }));
jest.mock('@/db/workflows-db', () => ({ getWorkflowsDatabase: jest.fn() }));

import { getDatabase } from '@/db/connection';
import { getWorkflowsDatabase } from '@/db/workflows-db';
import { AnalyticsReconciliationService } from '../analytics';

describe('AnalyticsReconciliationService', () => {
  let sharedDb: any;
  let insertValues: jest.Mock;
  let updateSet: jest.Mock;

  beforeEach(() => {
    insertValues = jest.fn(() => ({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }));
    updateSet = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
    const tx = {
      insert: jest.fn(() => ({ values: insertValues })),
      update: jest.fn(() => ({ set: updateSet })),
    };
    sharedDb = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([
            {
              runId: 'run-1',
              storyId: 'story-1',
              creditsSpent: 3,
              clientId: '123.456',
              sessionId: 123,
              consent: {
                analyticsStorage: 'granted',
                adUserData: 'denied',
                adPersonalization: 'denied',
              },
            },
          ]),
        })),
      })),
      transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    (getDatabase as jest.Mock).mockReturnValue(sharedDb);
    (getWorkflowsDatabase as jest.Mock).mockReturnValue({});
    jest.clearAllMocks();
  });

  it('writes one sanitized terminal event and updates the shared request', async () => {
    const service = new AnalyticsReconciliationService();
    const result = await service.recordTerminalRun({
      runId: 'run-1',
      storyId: 'story-1',
      status: 'failed',
      currentStep: 'Generate Chapters',
      errorMessage: 'Unauthorized token for child@example.com',
      startedAt: '2026-07-17T00:00:00.000Z',
      endedAt: '2026-07-17T00:01:30.000Z',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:01:30.000Z',
      gcpWorkflowExecution: null,
      metadata: null,
    });

    expect(result).toBe(true);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'story:run-1:failed',
        eventName: 'story_generation_failed',
        params: expect.objectContaining({
          duration_seconds: 90,
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
});
