/**
 * Story Context Service
 * Manages story generation context across multiple AI requests
 */

import { readFile } from 'fs/promises';
import { posix as pathPosix } from 'path';
import { AIGateway } from '@/ai/gateway.js';
import { contextManager } from '@/ai/context-manager.js';
import { StoryService, StoryContext } from './story.js';
import { PromptService } from './prompt.js';
import { logger } from '@/config/logger.js';
import { formatTargetAudience } from '@/shared/utils.js';
import { getPromptsPath } from '@/shared/path-utils.js';

export interface StoryGenerationSession {
  contextId: string;
  storyId: string;
  storyContext: StoryContext;
  currentStep: string;
  aiGateway: AIGateway;
}

/**
 * Format characters for prompt injection
 */
function formatCharactersForPrompt(
  characters: StoryContext['characters'],
): string {
  return characters
    .map((char, index) => {
      const parts = [`${index + 1}. **${char.name}**`];
      if (char.role) parts.push(`(${char.role})`);
      if (char.type) parts.push(`- Type: ${char.type}`);
      if (char.age) parts.push(`- Age: ${char.age}`);
      if (char.traits?.length) parts.push(`- Traits: ${char.traits.join(', ')}`);
      if (char.characteristics) parts.push(`- Characteristics: ${char.characteristics}`);
      if (char.physicalDescription) parts.push(`- Description: ${char.physicalDescription}`);
      return parts.join(' ');
    })
    .join('\n');
}

type AudienceGuidanceMap = Record<string, string>;

// Length guidance per target audience
const lengthGuidanceMap: Record<string, string> = {
  'children_0-2': '1-2 very short paragraphs; keep sentences 1-2 lines; heavy repetition and sensory cues.',
  'children_3-6': '2-4 concise paragraphs; 2-4 sentences each; ~100-300 words; keep dialogue to 4 turns.',
  'children_7-10': '4-8 paragraphs; 2-4 sentences each; ~400-800 words; dialogue limited to key beats.',
  'children_11-14': '6-12 paragraphs; 5-8 sentences each; ~800-1500 words; mix action and reflection.',
  'young_adult_15-17': '8-15 paragraphs; 6-10 sentences each; ~1200-2500 words; allow complex dialogue.',
  'adult_18+': '10-20 paragraphs; 6-12 sentences each; ~1500-4000 words; full narrative freedom.',
  all_ages: 'Balanced length; keep prose warm and accessible for mixed ages; avoid extreme pacing.',
};

// Pacing and plot-structure guidance per target audience
const pacingGuidanceMap: Record<string, string> = {
  'children_0-2': 'Use a soothing, repetitive rhythm; 1 clear beat per page; focus on sensory moments; no rapid shifts.',
  'children_3-6': 'Simple beginning-middle-end with 3 core beats: gentle hook, friendly complication, comforting resolution.',
  'children_7-10': '3-4 act flow: hook, rising fun/problem, climax, cozy wrap-up; short beats and quick payoffs.',
  'children_11-14': 'Classic 3-act with clear stakes; alternate action and reflection; keep momentum steady, avoid long detours.',
  'young_adult_15-17': '3-act with subplots; build tension over multiple beats; allow quieter character moments between set pieces.',
  'adult_18+': 'Flexible 3- or 4-act structure; braid main and subplot beats; vary pacing but keep throughline visible.',
  all_ages: 'Use a clear 3-act throughline (setup, confrontation, resolution) with evenly spaced beats and no pacing whiplash.',
};

let cachedAudienceGuidance: AudienceGuidanceMap | null = null;

async function loadAudienceGuidance(): Promise<AudienceGuidanceMap> {
  if (cachedAudienceGuidance) return cachedAudienceGuidance;

  const filePath = pathPosix.join(getPromptsPath(), 'en-US', 'target-audience-guidance.json');
  try {
    const raw = await readFile(filePath, 'utf-8');
    cachedAudienceGuidance = JSON.parse(raw) as AudienceGuidanceMap;
    return cachedAudienceGuidance;
  } catch (error) {
    logger.warn('Failed to load audience guidance, using defaults', {
      error: error instanceof Error ? error.message : String(error),
      filePath,
    });
    cachedAudienceGuidance = {};
    return cachedAudienceGuidance;
  }
}

async function getAudienceGuidance(targetAudience?: string): Promise<string> {
  const guidanceMap = await loadAudienceGuidance();
  const key = targetAudience || 'all_ages';
  return guidanceMap[key] || guidanceMap.all_ages || 'Keep tone and complexity aligned to the audience.';
}

function getLengthGuidance(targetAudience?: string): string {
  const key = targetAudience || 'all_ages';
  return lengthGuidanceMap[key] || lengthGuidanceMap.all_ages;
}

function getPacingGuidance(targetAudience?: string): string {
  const key = targetAudience || 'all_ages';
  return pacingGuidanceMap[key] || pacingGuidanceMap.all_ages;
}

function buildVoiceGuidance(story: StoryContext['story']): string {
  const audience = formatTargetAudience(story.targetAudience);
  const style = (story.novelStyle || 'narrative').toLowerCase();
  return `Maintain a consistent ${style} narrative voice; default to close third-person past unless explicitly specified; keep POV and tense steady; adjust vocabulary and cadence to suit ${audience}; avoid jarring tone shifts.`;
}

export class StoryContextService {
  private storyService = new StoryService();
  /**
   * Get context manager instance
   */
  getContextManager() {
    return contextManager;
  }

  /**
   * Get story service instance
   */
  getStoryService() {
    return this.storyService;
  }

  /**
   * Initialize a story generation session with context
   */
  async initializeStorySession(
    storyId: string,
    runId: string,
    aiGateway: AIGateway,
  ): Promise<StoryGenerationSession> {
    try {
      // Get story context from database
      const storyContext = await this.storyService.getStoryContext(storyId);
      if (!storyContext) {
        throw new Error(`Story context not found for story ${storyId}`);
      }

      // Create context ID from story and run
      const contextId = `${storyId}-${runId}`;

      // Create system prompt using PromptService
      const systemPrompt = await this.buildSystemPrompt(storyContext);

      // Initialize context manager
      await contextManager.initializeContext(contextId, storyId, systemPrompt);

      // Initialize AI provider context
      const textService = aiGateway.getTextService();
      if (textService.initializeContext) {
        await textService.initializeContext(contextId, systemPrompt);
      }

      const session: StoryGenerationSession = {
        contextId,
        storyId,
        storyContext,
        currentStep: 'initialized',
        aiGateway,
      };

      logger.info('Story generation session initialized', {
        contextId,
        storyId,
        runId,
        storyTitle: storyContext.story.title,
        charactersCount: storyContext.characters.length,
      });

      return session;
    } catch (error) {
      logger.error('Failed to initialize story session', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        runId,
      });
      throw error;
    }
  }

  /**
   * Generate story outline with context
   */
  async generateOutline(
    session: StoryGenerationSession,
    additionalPrompt?: string,
  ): Promise<string> {
    try {
      const prompt = await this.buildOutlinePrompt(session.storyContext, additionalPrompt);

      const textService = session.aiGateway.getTextService();
      const outline = await textService.complete(prompt, {
        contextId: session.contextId,
        temperature: 1.0,
      });

      // Update session step
      session.currentStep = 'outline-generated';

      logger.info('Story outline generated', {
        contextId: session.contextId,
        storyId: session.storyId,
        outlineLength: outline.length,
      });

      return outline;
    } catch (error) {
      logger.error('Failed to generate story outline', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId,
      });
      throw error;
    }
  }

  /**
   * Generate chapter with context
   */
  async generateChapter(
    session: StoryGenerationSession,
    chapterNumber: number,
    chapterTitle: string,
    outline?: string,
  ): Promise<string> {
    try {
      const prompt = await this.buildChapterPrompt(
        session.storyContext,
        chapterNumber,
        chapterTitle,
        outline,
      );

      const textService = session.aiGateway.getTextService();
      const chapter = await textService.complete(prompt, {
        contextId: session.contextId,
        temperature: 0.9,
      });

      // Update session step
      session.currentStep = `chapter-${chapterNumber}-generated`;

      logger.info('Story chapter generated', {
        contextId: session.contextId,
        storyId: session.storyId,
        chapterNumber,
        chapterLength: chapter.length,
      });

      return chapter;
    } catch (error) {
      logger.error('Failed to generate story chapter', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId,
        chapterNumber,
      });
      throw error;
    }
  }

  /**
   * Clean up story session
   */
  async cleanupSession(session: StoryGenerationSession): Promise<void> {
    try {
      // Clear context from AI provider
      const textService = session.aiGateway.getTextService();
      if (textService.clearContext) {
        await textService.clearContext(session.contextId);
      }

      // Clear context from context manager
      await contextManager.clearContext(session.contextId);

      logger.info('Story session cleaned up', {
        contextId: session.contextId,
        storyId: session.storyId,
      });
    } catch (error) {
      logger.error('Failed to cleanup story session', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId,
      });
      throw error;
    }
  }

  /**
   * Build system prompt using PromptService
   */
  private async buildSystemPrompt(storyContext: StoryContext): Promise<string> {
    const { story, characters } = storyContext;
    const promptTemplate = await PromptService.loadPrompt('en-US', 'story-system');
    const audienceGuidance = await getAudienceGuidance(story.targetAudience);
    const pacingGuidance = getPacingGuidance(story.targetAudience);
    const voiceGuidance = buildVoiceGuidance(story);

    const templateVars = {
      title: story.title,
      targetAudience: formatTargetAudience(story.targetAudience),
      novelStyle: story.novelStyle || 'Adventure',
      place: story.place || 'Not specified',
      plotDescription: story.plotDescription || '',
      synopsis: story.synopsis || '',
      additionalRequests: story.additionalRequests || '',
      imageGenerationInstructions: story.imageGenerationInstructions || '',
      characters: formatCharactersForPrompt(characters),
      audienceGuidance,
      pacingGuidance,
      voiceGuidance,
    };

    return PromptService.processPrompt(promptTemplate.systemPrompt || '', templateVars);
  }

  /**
   * Build outline generation prompt using PromptService
   */
  private async buildOutlinePrompt(
    storyContext: StoryContext,
    additionalPrompt?: string,
  ): Promise<string> {
    const promptTemplate = await PromptService.loadPrompt('en-US', 'story-outline-session');
    const audienceGuidance = await getAudienceGuidance(storyContext.story.targetAudience);
    const pacingGuidance = getPacingGuidance(storyContext.story.targetAudience);
    const voiceGuidance = buildVoiceGuidance(storyContext.story);
    const characters = formatCharactersForPrompt(storyContext.characters);
    return PromptService.buildPrompt(promptTemplate, {
      additionalPrompt: additionalPrompt || '',
      audienceGuidance,
      pacingGuidance,
      voiceGuidance,
      characters,
    });
  }

  /**
   * Build chapter generation prompt using PromptService
   */
  private async buildChapterPrompt(
    storyContext: StoryContext,
    chapterNumber: number,
    chapterTitle: string,
    outline?: string,
  ): Promise<string> {
    const promptTemplate = await PromptService.loadPrompt('en-US', 'story-chapter-session');
    const audienceGuidance = await getAudienceGuidance(storyContext.story.targetAudience);
    const lengthGuidance = getLengthGuidance(storyContext.story.targetAudience);
    const pacingGuidance = getPacingGuidance(storyContext.story.targetAudience);
    const voiceGuidance = buildVoiceGuidance(storyContext.story);
    const characters = formatCharactersForPrompt(storyContext.characters);
    return PromptService.buildPrompt(promptTemplate, {
      chapterNumber: chapterNumber.toString(),
      chapterTitle,
      outline: outline || '',
      audienceGuidance,
      lengthGuidance,
      pacingGuidance,
      voiceGuidance,
      characters,
    });
  }
}
