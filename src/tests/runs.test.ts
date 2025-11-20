import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/db/workflows-db', () => ({
  getWorkflowsDatabase: jest.fn(),
  storyGenerationRuns: {},
  storyGenerationSteps: {},
}));

import { RunsService } from '../services/runs';
import { getWorkflowsDatabase } from '@/db/workflows-db';
import { logger } from '@/config/logger';

describe('RunsService', () => {
  let service: RunsService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: jest.fn(),
      select: jest.fn(),
      update: jest.fn(),
    };
    (getWorkflowsDatabase as jest.Mock).mockReturnValue(mockDb);
    service = new RunsService();
    jest.clearAllMocks();
  });

  it('creates a run', async () => {
    const returningMock = jest
      .fn()
      .mockResolvedValue([{ runId: 'r1', storyId: 's1', status: 'queued' }]);
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: returningMock }),
    });

    const result = await service.createRun('s1', 'r1', 'exec1');

    expect(result.runId).toBe('r1');
    expect(mockDb.insert).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('returns existing run in createOrGetRun', async () => {
    const existing = { runId: 'r1', storyId: 's1', status: 'queued' };
    const spy = jest.spyOn(service, 'getRun').mockResolvedValue(existing as any);

    const result = await service.createOrGetRun('s1', 'r1');

    expect(result).toBe(existing);
    expect(spy).toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('updates run status transitions', async () => {
    const getRunSpy = jest
      .spyOn(service, 'getRun')
      .mockResolvedValue({ runId: 'r1', storyId: 's1', metadata: {} } as any);
    const returningMock = jest
      .fn()
      .mockResolvedValue([{ runId: 'r1', status: 'running', currentStep: null }]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await service.updateRun('r1', { status: 'running' });

    expect(setMock.mock.calls[0][0].startedAt).toBeDefined();
    expect(result.status).toBe('running');

    returningMock.mockResolvedValue([{ runId: 'r1', status: 'completed', currentStep: null }]);
    await service.updateRun('r1', { status: 'completed' });
    expect(setMock.mock.calls[1][0].endedAt).toBeDefined();
    getRunSpy.mockRestore();
  });

  it('retrieves run and steps', async () => {
    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ runId: 'r1', storyId: 's1' }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ stepName: 's', status: 'completed' }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ stepName: 'a', status: 'completed' }]),
        }),
      });

    const run = await service.getRun('r1');
    expect(run?.storyId).toBe('s1');

    const steps = await service.getRunSteps('r1');
    expect(steps).toHaveLength(1);

    const step = await service.getStepResult('r1', 'a');
    expect(step?.stepName).toBe('a');
  });
});
