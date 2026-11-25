import { jest, beforeEach, it, expect, describe } from '@jest/globals';
const mockGetRun = jest.fn<any>();
const mockGetSteps = jest.fn<any>();
const mockStore = jest.fn<any>();
const mockContext = jest.fn<any>();
const mockSaveChapter = jest.fn<any>();
const mockIdentity = jest.fn<any>();
const mockUsage = jest.fn<any>();
const mockPrepare = jest.fn<any>();
const mockSegment = jest.fn<any>();
const mockSave = jest.fn<any>();
const mockLoad = jest.fn<any>();
const mockRelease = jest.fn<any>();
const mockQuery = jest.fn<any>();
const mockEnv = {
  STORY_TEXT_GENERATION_MODE: 'hybrid',
  STORY_SEQUENTIAL_AUDIENCES: 'young_adult_15-17,adult_18+',
  STORY_SEQUENTIAL_MIN_CHAPTERS: 8,
  STORY_WHOLE_MAX_OUTPUT_TOKENS: 262144,
  STORY_CHAPTER_MAX_OUTPUT_TOKENS: 131072,
};
jest.mock('@/config/environment.js', () => ({ getEnvironment: () => mockEnv }));
jest.mock('@/db/connection.js', () => ({
  acquireDatabaseClient: jest.fn(async () => ({
    query: mockQuery,
    release: mockRelease,
    on: jest.fn(),
    off: jest.fn(),
  })),
}));
jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => ({
    updateRun: jest.fn(async () => ({})),
    getRun: mockGetRun,
    getRunSteps: mockGetSteps,
    storeStepResult: mockStore,
  })),
}));
jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({ getStoryContext: mockContext })),
}));
jest.mock('@/services/chapters.js', () => ({
  ChaptersService: jest.fn(() => ({
    saveChapterOnce: mockSaveChapter,
    getPersistedIdentity: mockIdentity,
  })),
}));
jest.mock('@/services/token-usage-tracking.js', () => ({
  tokenUsageTrackingService: { recordUsage: mockUsage },
}));
jest.mock('@/services/literary-persona.js', () => ({
  LiteraryPersonaService: { buildGuidance: jest.fn(async () => 'Warm narrative') },
}));
jest.mock('@/services/progress-tracker.js', () => ({
  ProgressTrackerService: jest.fn(() => ({ updateStoryProgress: jest.fn(async () => {}) })),
}));
jest.mock('@/services/story-text-checkpoint.js', () => ({
  saveTextCheckpoint: mockSave,
  loadTextCheckpoint: mockLoad,
}));
import { GoogleGenAITextService } from '../ai/providers/google-genai/text.js';
const mockProvider = Object.create(GoogleGenAITextService.prototype);
mockProvider.prepareRequest = mockPrepare;
mockProvider.generateSegment = mockSegment;
jest.mock('@/ai/gateway-singleton.js', () => ({
  getAIGateway: () => ({ getTextService: () => mockProvider }),
}));
import { StoryTextService } from '../services/story-text.js';
let steps: Array<{ stepName: string; status: string; detailJson: unknown }>;
let state: any;
const prose = '<p>A complete scene with an ending.</p>';
const whole = JSON.stringify({
  chapters: [1, 2].map((chapterNumber) => ({ chapterNumber, htmlContent: prose })),
});
const segment = (text: string, finishReason = 'STOP', continuationToken?: string) => ({
  parts: [{ text }],
  finishReason,
  continuationToken,
  usage: { inputTokens: 100, outputTokens: 40, thinkingTokens: 10, cachedInputTokens: 20 },
});
describe('durable Hydrogen story generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state = undefined;
    mockEnv.STORY_TEXT_GENERATION_MODE = 'hybrid';
    steps = [
      {
        stepName: 'generate_outline',
        status: 'completed',
        detailJson: {
          chapters: [1, 2].map((chapterNumber) => ({
            chapterNumber,
            chapterTitle: `Title ${chapterNumber}`,
            chapterSynopses: 'A developed scene',
          })),
        },
      },
    ];
    mockGetRun.mockResolvedValue({ status: 'running', storyId: 'story' });
    mockGetSteps.mockImplementation(async () => globalThis.structuredClone(steps));
    mockStore.mockImplementation(async (runId: string, stepName: string, value: any) => {
      const index = steps.findIndex((step) => step.stepName === stepName);
      const row = { stepName, status: value.status, detailJson: value.result };
      if (index < 0) steps.push(row);
      else steps[index] = row;
    });
    mockContext.mockResolvedValue({
      story: {
        authorId: 'author',
        targetAudience: 'children_3-6',
        storyLanguage: 'en-US',
        title: 'Story',
      },
      characters: [],
    });
    mockSave.mockImplementation(async (_path: string, _run: string, value: unknown) => {
      state = globalThis.structuredClone(value);
    });
    mockLoad.mockImplementation(async () => globalThis.structuredClone(state));
    mockQuery.mockResolvedValue({ rows: [{ locked: true }] });
    mockPrepare.mockImplementation(async (prompt: string, options: any) => ({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: options,
    }));
    mockSegment.mockResolvedValue(segment(whole));
    mockSaveChapter.mockImplementation(async (_data: any, id: string) => ({ id, version: 1 }));
    mockIdentity.mockImplementation(async (_story: string, _number: number, id: string) => ({
      id,
      version: 1,
    }));
    mockUsage.mockResolvedValue(undefined);
  });
  it('generates all chapters once and returns idempotent persisted receipts', async () => {
    const first = await new StoryTextService().advance('run', 1);
    expect(first).toMatchObject({
      status: 'completed',
      mode: 'whole_story',
      chapterNumber: 1,
      version: 1,
    });
    expect(mockSaveChapter).toHaveBeenCalledTimes(2);
    const second = await new StoryTextService().advance('run', 2);
    expect(second).toMatchObject({ status: 'completed', chapterNumber: 2 });
    expect(mockSegment).toHaveBeenCalledTimes(1);
    expect(mockUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 20,
        inputPromptJson: expect.objectContaining({ operation: 'whole_story_writing' }),
      }),
      true,
    );
  });
  it('resumes after a restart using the token and unchanged request, including empty thinking segments', async () => {
    mockSegment
      .mockResolvedValueOnce(segment('', 'CONTINUATION', 'opaque'))
      .mockResolvedValueOnce(segment(whole));
    expect(await new StoryTextService().advance('run', 1)).toMatchObject({ status: 'pending' });
    expect(mockSaveChapter).not.toHaveBeenCalled();
    const request = globalThis.structuredClone(state.operation.request);
    await new StoryTextService().advance('run', 1);
    expect(mockSegment.mock.calls[1][0]).toEqual(request);
    expect(mockSegment.mock.calls[1][1]).toBe('opaque');
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });
  it('falls back once and supplies only completed same-run chapters', async () => {
    mockSegment.mockResolvedValueOnce(segment('{"chapters":[]}')).mockResolvedValue(segment(prose));
    expect(await new StoryTextService().advance('run', 1)).toMatchObject({
      status: 'pending',
      mode: 'chapter_by_chapter',
    });
    await new StoryTextService().advance('run', 1);
    await new StoryTextService().advance('run', 2);
    expect(mockPrepare.mock.calls[2][0]).toContain(prose);
    expect(mockPrepare.mock.calls[2][0]).not.toContain('__SAVED_CHAPTER_HISTORY__');
    expect(mockUsage).toHaveBeenCalledTimes(3);
  });
  it('recovers the same chapter ID across a core/workflow persistence failure', async () => {
    mockStore
      .mockImplementationOnce(async (_run: string, stepName: string, value: any) =>
        steps.push({ stepName, status: value.status, detailJson: value.result }),
      )
      .mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(new StoryTextService().advance('run', 1)).rejects.toThrow('DB unavailable');
    const id = mockSaveChapter.mock.calls[0][1];
    mockStore.mockImplementation(async (_run: string, stepName: string, value: any) =>
      steps.push({ stepName, status: value.status, detailJson: value.result }),
    );
    await new StoryTextService().advance('run', 1);
    expect(mockSaveChapter.mock.calls[1][1]).toBe(id);
    expect(mockSegment).toHaveBeenCalledTimes(1);
  });
  it('retries usage persistence using the same ID before continuing generation', async () => {
    mockUsage.mockRejectedValueOnce(new Error('Usage DB unavailable')).mockResolvedValue(undefined);
    await expect(new StoryTextService().advance('run', 1)).rejects.toThrow('Usage DB unavailable');
    const id = state.operation.pendingUsage.tokenUsageId;
    await new StoryTextService().advance('run', 1);
    expect(mockUsage.mock.calls[1][0].tokenUsageId).toBe(id);
    expect(mockSegment).toHaveBeenCalledTimes(1);
  });
  it('does not publish truncated output or retry a safety block as another generation mode', async () => {
    mockSegment.mockResolvedValueOnce(segment(prose, 'MAX_TOKENS'));
    expect(await new StoryTextService().advance('run', 1)).toMatchObject({
      mode: 'chapter_by_chapter',
      status: 'pending',
    });
    mockSegment.mockRejectedValueOnce(Object.assign(new Error('Safety'), { status: 422 }));
    await expect(new StoryTextService().advance('run', 1)).rejects.toMatchObject({ status: 422 });
    expect(mockSaveChapter).not.toHaveBeenCalled();
  });
  it('rejects concurrent advancement and releases database resources', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ locked: false }] });
    await expect(new StoryTextService().advance('run', 1)).rejects.toMatchObject({ status: 409 });
    expect(mockRelease).toHaveBeenCalled();
    expect(mockSegment).not.toHaveBeenCalled();
  });
  it('retries definitive transient rejections using the same request', async () => {
    mockSegment.mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { status: 429 }));
    await expect(new StoryTextService().advance('run', 1)).rejects.toMatchObject({ status: 429 });
    const original = globalThis.structuredClone(state.operation.request);
    mockSegment.mockResolvedValueOnce(segment(whole));
    await new StoryTextService().advance('run', 1);
    expect(mockSegment.mock.calls[1][0]).toEqual(original);
  });

  it('does not silently regenerate after an unknown network outcome', async () => {
    mockSegment.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(new StoryTextService().advance('run', 1)).rejects.toThrow('Connection lost');
    await expect(new StoryTextService().advance('run', 1)).rejects.toMatchObject({
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(mockSegment).toHaveBeenCalledTimes(1);
  });
});
