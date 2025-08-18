import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@/shared/utils', () => ({
  retry: jest.fn((fn: () => Promise<unknown>) => fn()),
}));

const mockRunsService = {
  getStepResult: jest.fn(),
  getRun: jest.fn(),
  getRunSteps: jest.fn(),
};
const mockStoryService = {
  getStory: jest.fn(),
  updateStoryCompletionPercentage: jest.fn(),
  updateStoryStatus: jest.fn(),
};

jest.mock('../services/runs', () => ({
  RunsService: jest.fn().mockImplementation(() => mockRunsService),
}));

jest.mock('../services/story', () => ({
  StoryService: jest.fn().mockImplementation(() => mockStoryService),
}));

import { ProgressTrackerService } from '../services/progress-tracker';
import { logger } from '@/config/logger';

describe('ProgressTrackerService', () => {
  let service: ProgressTrackerService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = new ProgressTrackerService();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('caches chapter counts from outline', async () => {
    mockRunsService.getStepResult.mockResolvedValue({ detailJson: { chapters: [1, 2, 3] } });
    const count1 = await (service as any).getChapterCount('r1');
    const count2 = await (service as any).getChapterCount('r1');
    expect(count1).toBe(3);
    expect(count2).toBe(3);
    expect(mockRunsService.getStepResult).toHaveBeenCalledTimes(1);
  });

  it('calculates progress based on completed steps', async () => {
    mockRunsService.getRun.mockResolvedValue({ runId: 'r1', storyId: 's1', status: 'running', currentStep: 'write_chapter_1' });
    mockRunsService.getStepResult.mockResolvedValue({ detailJson: { chapters: [{}, {}] } });
    mockRunsService.getRunSteps.mockResolvedValue([
      { stepName: 'generate_outline', status: 'completed' },
      { stepName: 'write_chapter_1', status: 'completed' },
    ]);

    const result = await service.calculateProgress('r1');
    expect(result.completedPercentage).toBe(14);
    expect(result.totalEstimatedTime).toBeGreaterThan(200);
    expect(result.completedSteps).toHaveLength(2);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('updates story progress and publishes on completion', async () => {
    mockRunsService.getRun.mockResolvedValue({ runId: 'r1', storyId: 's1', status: 'completed', currentStep: 'done' });
    jest.spyOn(service, 'calculateProgress').mockResolvedValue({
      completedPercentage: 80,
      totalEstimatedTime: 0,
      elapsedTime: 0,
      remainingTime: 0,
      currentStep: 'done',
      completedSteps: [],
      totalSteps: 0,
    });

    await service.updateStoryProgress('r1');

    expect(mockStoryService.updateStoryCompletionPercentage).toHaveBeenCalledWith('s1', 100);
    expect(mockStoryService.updateStoryStatus).toHaveBeenCalledWith('s1', 'published');
    expect(logger.info).toHaveBeenCalled();
  });

  it('throws when run not found', async () => {
    mockRunsService.getRun.mockResolvedValue(null);
    await expect(service.calculateProgress('bad')).rejects.toThrow('Run not found');
    expect(logger.error).toHaveBeenCalled();
  });
});

