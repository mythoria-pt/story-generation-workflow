import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import './setup/environment-mock';

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

jest.mock('../services/event', () => ({
  eventService: {
    hasEvent: jest.fn().mockResolvedValue(false),
    recordEvent: jest.fn(),
  },
}));

jest.mock('../services/notification-client', () => ({
  sendStoryCreatedEmail: jest.fn().mockResolvedValue(true),
}));

import { ProgressTrackerService } from '../services/progress-tracker';
import { logger } from '@/config/logger';
import { sendStoryCreatedEmail } from '../services/notification-client';

const mockedSendStoryCreatedEmail = sendStoryCreatedEmail as jest.MockedFunction<
  typeof sendStoryCreatedEmail
>;

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
    mockRunsService.getStepResult.mockResolvedValue({
      detailJson: { chapters: [1, 2, 3] },
    });
    const count1 = await (service as any).getChapterCount('r1');
    const count2 = await (service as any).getChapterCount('r1');
    expect(count1).toBe(3);
    expect(count2).toBe(3);
    expect(mockRunsService.getStepResult).toHaveBeenCalledTimes(1);
  });

  it('calculates progress based on completed steps', async () => {
    mockRunsService.getRun.mockResolvedValue({
      runId: 'r1',
      storyId: 's1',
      status: 'running',
      currentStep: 'write_chapter_1',
    });
    mockRunsService.getStepResult.mockResolvedValue({
      detailJson: { chapters: [{}, {}] },
    });
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
    mockRunsService.getRun.mockResolvedValue({
      runId: 'r1',
      storyId: 's1',
      status: 'completed',
      currentStep: 'done',
    });
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

  it('dispatches story-created email when a story-generation run completes', async () => {
    const runId = 'r-email';
    const storyId = 's-email';

    mockRunsService.getRun.mockResolvedValue({
      runId,
      storyId,
      status: 'completed',
      currentStep: 'done',
      metadata: { serviceCode: 'storyGeneration' },
    });

    jest.spyOn(service, 'calculateProgress').mockResolvedValue({
      completedPercentage: 100,
      totalEstimatedTime: 0,
      elapsedTime: 0,
      remainingTime: 0,
      currentStep: 'done',
      completedSteps: [],
      totalSteps: 0,
    });

    mockStoryService.getStory.mockResolvedValue({
      storyId,
      title: 'Journey to Mythoria',
      synopsis: 'A heroic quest.',
      coverUri: 'https://example.com/cover.png',
      author: 'A. Author',
      authorEmail: 'author@example.com',
      authorPreferredLocale: 'pt-PT',
      authorId: 'author-123',
    });

    await service.updateStoryProgress(runId);
    await Promise.resolve();

    expect(mockedSendStoryCreatedEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendStoryCreatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId,
        templateId: 'story-created',
        recipients: [
          {
            email: 'author@example.com',
            name: 'A. Author',
            language: 'pt-PT',
          },
        ],
        variables: expect.objectContaining({
          readStoryURL: expect.stringContaining(`/stories/read/${storyId}`),
          orderPrintURL: expect.stringContaining(`/stories/print/${storyId}`),
          shareStoryURL: expect.stringContaining(`/stories/read/${storyId}`),
        }),
      }),
    );
  });
});
