import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const contextManagerMock = {
  initializeContext: jest.fn(),
  getContext: jest.fn(),
  updateProviderData: jest.fn(),
  clearContext: jest.fn(),
  cleanupOldContexts: jest.fn(),
  getStats: jest.fn(),
};

jest.mock('@/ai/context-manager.js', () => ({
  contextManager: contextManagerMock,
}));

const mockGetStoryContext = jest.fn();
const mockGetStory = jest.fn();
const StoryServiceMock = jest.fn(() => ({
  getStoryContext: mockGetStoryContext,
  getStory: mockGetStory,
}));

jest.mock('../services/story', () => ({
  StoryService: StoryServiceMock,
}));

jest.mock('@/ai/gateway-singleton.js', () => ({
  getAIGateway: jest.fn(),
}));

import { StoryContextService, type StoryGenerationSession } from '../services/story-context';
import { StoryOutlineHandler, ChapterWritingHandler } from '../workflows/handlers';
import { contextManager } from '@/ai/context-manager.js';
import { getAIGateway } from '@/ai/gateway-singleton.js';

const baseStoryContext = {
  story: {
    storyId: 'story-1',
    title: 'The Enchanted Forest',
    targetAudience: 'children_7-10',
    novelStyle: 'Fantasy',
    place: 'Mythoria',
    plotDescription: 'A band of friends explores a magical forest.',
    synopsis: 'They learn about friendship and courage.',
    additionalRequests: 'Keep tone whimsical.',
    imageGenerationInstructions: 'Use bright colors.',
  },
  characters: [
    {
      name: 'Luna',
      role: 'Hero',
      type: 'Elf',
      age: '12',
      traits: ['brave', 'curious'],
      characteristics: 'sparkling aura',
      physicalDescription: 'Silver hair and green cloak',
    },
    {
      name: 'Orion',
      role: 'Guide',
      type: 'Fox',
      traits: ['wise'],
      characteristics: 'glowing tail',
      physicalDescription: 'Amber fur',
    },
  ],
} as const;

const createTextService = () => ({
  initializeContext: jest.fn(),
  complete: jest.fn(),
  clearContext: jest.fn(),
});

const createGateway = (textService: ReturnType<typeof createTextService>) => ({
  getTextService: jest.fn(() => textService),
});

const getAIGatewayMock = getAIGateway as jest.Mock;

beforeEach(() => {
  mockGetStoryContext.mockReset();
  mockGetStory.mockReset();
  StoryServiceMock.mockClear();
  Object.values(contextManagerMock).forEach((fn) => fn.mockReset());
  getAIGatewayMock.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('StoryContextService', () => {
  it('initializes story session with context manager and AI gateway', async () => {
    mockGetStoryContext.mockResolvedValue(baseStoryContext);
    const textService = createTextService();
    const gateway = createGateway(textService);
    const service = new StoryContextService();

    const session = await service.initializeStorySession('story-1', 'run-42', gateway as any);

    expect(mockGetStoryContext).toHaveBeenCalledWith('story-1');
    expect(contextManager.initializeContext).toHaveBeenCalledWith(
      'story-1-run-42',
      'story-1',
      expect.stringContaining('Title: The Enchanted Forest'),
    );
    expect(textService.initializeContext).toHaveBeenCalledWith(
      'story-1-run-42',
      expect.stringContaining('**Characters:**'),
    );
    expect(session).toEqual(
      expect.objectContaining({
        contextId: 'story-1-run-42',
        storyId: 'story-1',
        storyContext: baseStoryContext,
        currentStep: 'initialized',
      }),
    );
  });

  it('throws when story context is missing', async () => {
    mockGetStoryContext.mockResolvedValue(null);
    const textService = createTextService();
    const gateway = createGateway(textService);
    const service = new StoryContextService();

    await expect(
      service.initializeStorySession('missing-story', 'wf-1', gateway as any),
    ).rejects.toThrow('Story context not found for story missing-story');
    expect(contextManager.initializeContext).not.toHaveBeenCalled();
    expect(textService.initializeContext).not.toHaveBeenCalled();
  });

  it('generates outline using outline prompt and updates step', async () => {
    const textService = createTextService();
    textService.complete.mockResolvedValue('Outline result');
    const gateway = createGateway(textService);
    const service = new StoryContextService();
    const session: StoryGenerationSession = {
      contextId: 'ctx-1',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'initialized',
      aiGateway: gateway as any,
    };

    const outline = await service.generateOutline(session, 'Make it spooky');

    expect(textService.complete).toHaveBeenCalledWith(
      expect.stringContaining('Please create a detailed story outline'),
      expect.objectContaining({ contextId: 'ctx-1', temperature: 0.8 }),
    );
    expect(textService.complete.mock.calls[0][0]).toContain(
      'Additional requirements: Make it spooky',
    );
    expect(outline).toBe('Outline result');
    expect(session.currentStep).toBe('outline-generated');
  });

  it('generates chapter with outline context and updates step', async () => {
    const textService = createTextService();
    textService.complete.mockResolvedValue('Chapter body content');
    const gateway = createGateway(textService);
    const service = new StoryContextService();
    const session: StoryGenerationSession = {
      contextId: 'ctx-9',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'outline-generated',
      aiGateway: gateway as any,
    };

    const chapter = await service.generateChapter(
      session,
      2,
      'The Long Journey',
      'Outline snippet',
    );

    expect(textService.complete).toHaveBeenCalledWith(
      expect.stringContaining('Please write Chapter 2: "The Long Journey" of the story.'),
      expect.objectContaining({ contextId: 'ctx-9', temperature: 0.7 }),
    );
    expect(textService.complete.mock.calls[0][0]).toContain(
      'Based on the story outline:\nOutline snippet',
    );
    expect(chapter).toBe('Chapter body content');
    expect(session.currentStep).toBe('chapter-2-generated');
  });

  it('cleans up story session by clearing provider context and cache', async () => {
    const textService = createTextService();
    const gateway = createGateway(textService);
    const service = new StoryContextService();
    const session: StoryGenerationSession = {
      contextId: 'ctx-clean',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'chapter-1-generated',
      aiGateway: gateway as any,
    };

    await service.cleanupSession(session);

    expect(textService.clearContext).toHaveBeenCalledWith('ctx-clean');
    expect(contextManager.clearContext).toHaveBeenCalledWith('ctx-clean');
  });
});

describe('StoryOutlineHandler', () => {
  it('initializes session and extracts chapter titles via regex', async () => {
    const session: StoryGenerationSession = {
      contextId: 'ctx-h1',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'initialized',
      aiGateway: {} as any,
    };
    jest.spyOn(StoryContextService.prototype, 'initializeStorySession').mockResolvedValue(session);
    jest
      .spyOn(StoryContextService.prototype, 'generateOutline')
      .mockResolvedValue(
        'Chapter 1: Beginnings\nRandom text\nChapter 2: The Middle\nChapter 3: Finale',
      );
    const handler = new StoryOutlineHandler();

    const result = await handler.execute({
      storyId: 'story-1',
      workflowId: 'wf-9',
      prompt: 'Focus on mystery',
    });

    expect(getAIGatewayMock).toHaveBeenCalled();
    expect(result.outline).toContain('Chapter 1');
    expect(result.chapters).toEqual(['Beginnings', 'The Middle', 'Finale']);
  });

  it('falls back to default chapter names when outline lacks chapters', async () => {
    const session: StoryGenerationSession = {
      contextId: 'ctx-h2',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'initialized',
      aiGateway: {} as any,
    };
    jest.spyOn(StoryContextService.prototype, 'initializeStorySession').mockResolvedValue(session);
    jest
      .spyOn(StoryContextService.prototype, 'generateOutline')
      .mockResolvedValue('Outline without explicit chapter markers.');
    const handler = new StoryOutlineHandler();

    const result = await handler.execute({
      storyId: 'story-1',
      workflowId: 'wf-10',
      prompt: 'Keep it short',
    });

    expect(result.chapters).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  });

  it('propagates errors from story session initialization', async () => {
    jest
      .spyOn(StoryContextService.prototype, 'initializeStorySession')
      .mockRejectedValue(new Error('failed init'));
    const handler = new StoryOutlineHandler();

    await expect(
      handler.execute({ storyId: 'story-1', workflowId: 'wf-err', prompt: 'any' }),
    ).rejects.toThrow('failed init');
  });
});

describe('ChapterWritingHandler', () => {
  it('reuses existing context when available', async () => {
    contextManagerMock.getContext.mockResolvedValue({ contextId: 'story-1-wf-1' });
    mockGetStoryContext.mockResolvedValue(baseStoryContext);
    const session: StoryGenerationSession = {
      contextId: 'story-1-wf-1',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'outline-generated',
      aiGateway: {} as any,
    };
    jest.spyOn(StoryContextService.prototype, 'initializeStorySession').mockResolvedValue(session);
    jest
      .spyOn(StoryContextService.prototype, 'generateChapter')
      .mockResolvedValue('Chapter text content');
    const handler = new ChapterWritingHandler();

    const result = await handler.execute({
      storyId: 'story-1',
      workflowId: 'wf-1',
      outline: 'Outline reference',
      chapterIndex: 1,
    });

    expect(contextManager.getContext).toHaveBeenCalledWith('story-1-wf-1');
    expect(StoryContextService.prototype.initializeStorySession).not.toHaveBeenCalled();
    expect(StoryContextService.prototype.generateChapter).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'story-1-wf-1' }),
      1,
      'Chapter 1',
      'Outline reference',
    );
    expect(result.chapterContent).toBe('Chapter text content');
    expect(result.wordCount).toBe(3);
  });

  it('initializes session when context does not exist', async () => {
    contextManagerMock.getContext.mockResolvedValue(null);
    mockGetStoryContext.mockResolvedValue(baseStoryContext);
    const session: StoryGenerationSession = {
      contextId: 'story-1-wf-2',
      storyId: 'story-1',
      storyContext: baseStoryContext,
      currentStep: 'initialized',
      aiGateway: {} as any,
    };
    jest.spyOn(StoryContextService.prototype, 'initializeStorySession').mockResolvedValue(session);
    jest
      .spyOn(StoryContextService.prototype, 'generateChapter')
      .mockResolvedValue('Fresh chapter text');
    const handler = new ChapterWritingHandler();

    const result = await handler.execute({
      storyId: 'story-1',
      workflowId: 'wf-2',
      outline: 'Outline reference',
      chapterIndex: 2,
    });

    expect(StoryContextService.prototype.initializeStorySession).toHaveBeenCalled();
    expect(result.wordCount).toBe(3);
  });
});
