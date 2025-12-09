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

// Mock PromptService for async prompt loading
const mockLoadPrompt = jest.fn();
const mockBuildPrompt = jest.fn();
const mockProcessPrompt = jest.fn();

jest.mock('../services/prompt', () => ({
  PromptService: {
    loadPrompt: mockLoadPrompt,
    buildPrompt: mockBuildPrompt,
    processPrompt: mockProcessPrompt,
  },
}));

jest.mock('@/shared/utils.js', () => ({
  formatTargetAudience: jest.fn((audience) => audience || 'children ages 7-10'),
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

// Default prompt templates for mocks
const systemPromptTemplate = {
  systemPrompt:
    'You are a creative storyteller.\n\n<story_information>\n- Title: {{title}}\n- Target Audience: {{targetAudience}}\n</story_information>\n\n<characters>\n{{characters}}\n</characters>\n\n<audience_guidance>{{audienceGuidance}}</audience_guidance>\n<voice_guidance>{{voiceGuidance}}</voice_guidance>\n<pacing_guidance>{{pacingGuidance}}</pacing_guidance>',
};
const outlinePromptTemplate = {
  userPrompt:
    'Generate a clear, structured outline using the provided context. Keep instructions concise and outcome-focused.\n\n<audience_guidance>{{audienceGuidance}}</audience_guidance>\n<voice_guidance>{{voiceGuidance}}</voice_guidance>\n<pacing_guidance>{{pacingGuidance}}</pacing_guidance>\n\n<characters>\nUse every character as listed (names, roles, types, ages, traits, characteristics, physical descriptions). Do not invent new attributes.\n{{characters}}\n</characters>\n\n<requirements>\n- Opening that introduces characters and setting\n- Main conflict or adventure progression\n- 3-5 major plot points or chapters\n- Character growth using their unique abilities\n- Satisfying resolution\n</requirements>\n\n<visual_scene_guidelines>\nFor each major plot point, include settings, lighting, atmosphere, key visual elements, character positioning, and emotional expressions.\n</visual_scene_guidelines>\n\n<character_appearance_guidelines>\nAlways include physical descriptions for visible characters (hair, eyes, build, clothing, accessories, distinctive features) to support illustration prompts.\n</character_appearance_guidelines>\n\n<output_schema>\nReturn the outline using this shape for each chapter:\nChapter 1: Title\n- Summary: 1-2 sentences\n- Beats:\n  - Beat 1: setup or discovery\n  - Beat 2: escalation or complication\n  - Beat 3: consequence or transition\nEnsure chapter titles are explicit and numbered so they can be parsed reliably.\n</output_schema>\n{{#additionalPrompt}}\n<additional_requirements>{{additionalPrompt}}</additional_requirements>\n{{/additionalPrompt}}',
};
const chapterPromptTemplate = {
  userPrompt:
    'Write Chapter {{chapterNumber}}: "{{chapterTitle}}".\n{{#outline}}<story_outline>{{outline}}</story_outline>{{/outline}}\n\n<audience_guidance>{{audienceGuidance}}</audience_guidance>\n<voice_guidance>{{voiceGuidance}}</voice_guidance>\n<pacing_guidance>{{pacingGuidance}}</pacing_guidance>\n<length_guidance>{{lengthGuidance}}</length_guidance>\n\n<characters>\nUse every character as listed (names, roles, types, ages, traits, characteristics, physical descriptions). Keep continuity; do not invent new attributes.\n{{characters}}\n</characters>\n\n<chapter_requirements>\n- Maintain consistency with previous chapters and the overall story\n- Use vivid descriptions and engaging dialogue\n- Show character development and interactions\n- Include action and emotional moments appropriate for the target audience\n- End with a natural transition to the next chapter\n</chapter_requirements>\n\n<chapter_output_schema>\nProvide both a short summary and the full prose:\nSummary: 2-4 sentences covering key beats and emotions.\nBody:\n[Write the full chapter prose here]\n</chapter_output_schema>',
};

beforeEach(() => {
  mockGetStoryContext.mockReset();
  mockGetStory.mockReset();
  StoryServiceMock.mockClear();
  Object.values(contextManagerMock).forEach((fn) => fn.mockReset());
  getAIGatewayMock.mockReset();

  // Setup default prompt mock responses
  mockLoadPrompt.mockReset();
  mockBuildPrompt.mockReset();
  mockProcessPrompt.mockReset();

  mockLoadPrompt.mockImplementation((locale: string, promptName: string) => {
    if (promptName === 'story-system') return Promise.resolve(systemPromptTemplate);
    if (promptName === 'story-outline-session') return Promise.resolve(outlinePromptTemplate);
    if (promptName === 'story-chapter-session') return Promise.resolve(chapterPromptTemplate);
    return Promise.reject(new Error(`Unknown prompt: ${promptName}`));
  });

  mockProcessPrompt.mockImplementation((template: string, vars: Record<string, unknown>) => {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value || ''));
      // Handle conditionals
      const conditionalPattern = new RegExp(`\\{\\{#${key}\\}\\}(.*?)\\{\\{\\/${key}\\}\\}`, 'gs');
      if (value && String(value).trim() !== '') {
        result = result.replace(conditionalPattern, '$1');
      } else {
        result = result.replace(conditionalPattern, '');
      }
    }
    return result;
  });

  mockBuildPrompt.mockImplementation((template: { userPrompt?: string; systemPrompt?: string }, vars: Record<string, unknown>) => {
    const userPrompt = template.userPrompt || '';
    let result = userPrompt;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value || ''));
      const conditionalPattern = new RegExp(`\\{\\{#${key}\\}\\}(.*?)\\{\\{\\/${key}\\}\\}`, 'gs');
      if (value && String(value).trim() !== '') {
        result = result.replace(conditionalPattern, '$1');
      } else {
        result = result.replace(conditionalPattern, '');
      }
    }
    return result;
  });
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
    expect(mockLoadPrompt).toHaveBeenCalledWith('en-US', 'story-system');
    expect(contextManager.initializeContext).toHaveBeenCalledWith(
      'story-1-run-42',
      'story-1',
      expect.stringContaining('Title:'),
    );
    expect(textService.initializeContext).toHaveBeenCalledWith(
      'story-1-run-42',
      expect.any(String),
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

    expect(mockLoadPrompt).toHaveBeenCalledWith('en-US', 'story-outline-session');
    expect(textService.complete).toHaveBeenCalledWith(
      expect.stringContaining('Generate a clear, structured outline'),
      expect.objectContaining({ contextId: 'ctx-1', temperature: 1 }),
    );
    expect(textService.complete.mock.calls[0][0]).toContain('Luna');
    expect(textService.complete.mock.calls[0][0]).toContain('Make it spooky');
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

    expect(mockLoadPrompt).toHaveBeenCalledWith('en-US', 'story-chapter-session');
    expect(textService.complete).toHaveBeenCalledWith(
      expect.stringContaining('Write Chapter 2: "The Long Journey"'),
      expect.objectContaining({ contextId: 'ctx-9', temperature: 0.9 }),
    );
    expect(textService.complete.mock.calls[0][0]).toContain('Orion');
    expect(textService.complete.mock.calls[0][0]).toContain('Outline snippet');
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
