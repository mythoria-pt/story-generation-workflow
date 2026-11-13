import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import { acquireDatabaseClient } from '@/db/connection.js';
import { getAIGateway } from '@/ai/gateway-singleton.js';
import {
  GoogleGenAITextService,
  HYDROGEN_MODEL,
  type HydrogenRequest,
} from '@/ai/providers/google-genai/text.js';
import type { TextGenerationUsage } from '@/ai/interfaces.js';
import { RunsService } from './runs.js';
import { StoryService } from './story.js';
import { ChaptersService } from './chapters.js';
import { PromptService } from './prompt.js';
import { LiteraryPersonaService } from './literary-persona.js';
import { ProgressTrackerService } from './progress-tracker.js';
import { tokenUsageTrackingService, type TokenUsageRequest } from './token-usage-tracking.js';
import {
  formatTargetAudience,
  getLanguageName,
  prepareCharactersForPrompt,
} from '@/shared/utils.js';
import { saveTextCheckpoint, loadTextCheckpoint } from './story-text-checkpoint.js';
import {
  selectStoryTextMode,
  narrativeLengthGuidance,
  wholeStorySchema,
  validateWholeStory,
  validateChapterHtml,
  type StoryTextMode,
} from './story-text-policy.js';

const outlineSchema = z
  .object({
    chapters: z
      .array(
        z
          .object({
            chapterNumber: z.number().int().positive(),
            chapterTitle: z.string(),
            chapterSynopses: z.string(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
type Chapter = { chapterNumber: number; htmlContent: string; id: string };
interface Operation {
  request: HydrogenRequest;
  parts: Part[];
  token?: string;
  segment: number;
  finishReason?: string;
  pendingUsage?: TokenUsageRequest;
  requestPending?: boolean;
  requestedAt?: string;
}
interface State {
  version: 1;
  promptVersion: string;
  mode: StoryTextMode;
  originalMode: StoryTextMode;
  wholeBudget: number;
  chapterBudget: number;
  outline: z.infer<typeof outlineSchema>;
  audience: string;
  authorId: string;
  storyId: string;
  prompts: Array<{ systemInstruction?: string | undefined; userPrompt: string }>;
  wholePrompt: { systemInstruction?: string | undefined; userPrompt: string };
  operation?: Operation;
  drafts: Chapter[];
  completed: number[];
  fallbackReason?: string;
}
let activeAdvances = 0;
export class StoryTextService {
  private runs = new RunsService();
  private stories = new StoryService();
  private chapters = new ChaptersService();
  private async locked<T>(runId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (activeAdvances >= 4)
      throw Object.assign(new Error('Text generation capacity reached'), { status: 429 });
    activeAdvances++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_250_000);
    const client = await acquireDatabaseClient().catch((error) => {
      activeAdvances--;
      clearTimeout(timer);
      throw error;
    });
    const disconnected = () => controller.abort();
    client.on('error', disconnected);
    let locked = false;
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtext('story_text'), hashtext($1)) AS locked",
        [runId],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked)
        throw Object.assign(new Error('Text operation already running'), { status: 409 });
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
      activeAdvances--;
      client.off('error', disconnected);
      try {
        if (locked)
          await client.query("SELECT pg_advisory_unlock(hashtext('story_text'), hashtext($1))", [
            runId,
          ]);
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
  private async initialize(runId: string): Promise<{ state: State; path: string }> {
    const run = await this.runs.getRun(runId);
    if (!run || run.status !== 'running')
      throw Object.assign(new Error('Active generation run required'), { status: 409 });
    const steps = await this.runs.getRunSteps(runId);
    const saved = steps.find((step) => step.stepName === 'text_generation_state');
    const path = `${run.storyId}/text/${runId}/checkpoint.enc`;
    if (saved) return { state: await loadTextCheckpoint<State>(path, runId), path };
    const context = await this.stories.getStoryContext(run.storyId);
    if (!context) throw new Error('Story context unavailable');
    const outline = outlineSchema.parse(
      steps.find((step) => step.stepName === 'generate_outline' && step.status === 'completed')
        ?.detailJson,
    );
    if (outline.chapters.some((chapter, index) => chapter.chapterNumber !== index + 1))
      throw new Error('Invalid outline chapter ordering');
    const env = getEnvironment();
    const audience = context.story.targetAudience ?? 'all_ages';
    const mode = selectStoryTextMode(audience, outline.chapters.length, {
      mode: env.STORY_TEXT_GENERATION_MODE,
      audiences: env.STORY_SEQUENTIAL_AUDIENCES.split(',').map((value) => value.trim()),
      threshold: env.STORY_SEQUENTIAL_MIN_CHAPTERS,
      wholeBudget: env.STORY_WHOLE_MAX_OUTPUT_TOKENS,
      chapterBudget: env.STORY_CHAPTER_MAX_OUTPUT_TOKENS,
    });
    const template = await PromptService.loadPrompt('en-US', 'text-chapter');
    const persona = await LiteraryPersonaService.buildGuidance(
      context.story.literaryPersona,
      context.story.customWritingPersona,
      'en-US',
    );
    const shared = {
      novelStyle: context.story.novelStyle ?? 'adventure',
      averageAge: formatTargetAudience(audience),
      language: getLanguageName(context.story.storyLanguage),
      description: context.story.plotDescription ?? context.story.synopsis ?? '',
      additionalRequests: context.story.additionalRequests ?? '',
      literaryPersonaGuidance: persona,
      lengthGuidance: narrativeLengthGuidance(audience),
      chapterCount: String(outline.chapters.length),
    };
    const roster = prepareCharactersForPrompt(context.characters);
    const prompts = outline.chapters.map((chapter) => {
      const parts = PromptService.buildParts(template, {
        ...shared,
        chapterNumber: String(chapter.chapterNumber),
        chapterTitle: chapter.chapterTitle,
        chapterSynopses: chapter.chapterSynopses,
        fullHistory: '__SAVED_CHAPTER_HISTORY__',
        hookInstruction:
          chapter.chapterNumber === outline.chapters.length
            ? 'Resolve the story; do not introduce a new cliffhanger.'
            : 'Use a natural transition into the following chapter.',
      });
      return {
        ...parts,
        userPrompt: `<story_outline>${JSON.stringify(outline)}</story_outline>\n<characters>${roster}</characters>\n${parts.userPrompt}`,
      };
    });
    const wholeTemplate = await PromptService.loadPrompt('en-US', 'text-whole-story');
    const wholePrompt = PromptService.buildParts(wholeTemplate, {
      ...shared,
      outline: JSON.stringify(outline),
      characters: roster,
    });
    const state: State = {
      version: 1,
      promptVersion: 'hydrogen-v2',
      mode,
      originalMode: mode,
      wholeBudget: env.STORY_WHOLE_MAX_OUTPUT_TOKENS,
      chapterBudget: env.STORY_CHAPTER_MAX_OUTPUT_TOKENS,
      outline,
      audience,
      authorId: context.story.authorId,
      storyId: run.storyId,
      prompts,
      wholePrompt,
      drafts: [],
      completed: [],
    };
    // Import existing same-run commits when entering from a workflow deployed before this change.
    for (const step of steps) {
      const match = /^write_chapter_(\d+)$/.exec(step.stepName);
      if (match && step.status === 'completed') {
        const detail = step.detailJson as { chapter?: string; chapterId?: string };
        if (!detail.chapter || !detail.chapterId)
          throw new Error('Saved chapter history unavailable');
        state.drafts.push({
          chapterNumber: Number(match[1]),
          htmlContent: detail.chapter,
          id: detail.chapterId,
        });
        state.completed.push(Number(match[1]));
      }
    }
    if (state.completed.length) state.mode = 'chapter_by_chapter';
    await saveTextCheckpoint(path, runId, state);
    await this.runs.storeStepResult(runId, 'text_generation_state', {
      status: 'running',
      result: { path, mode: state.mode, model: HYDROGEN_MODEL, promptVersion: state.promptVersion },
    });
    return { state, path };
  }
  async plan(runId: string) {
    return this.locked(runId, async () => {
      const { state } = await this.initialize(runId);
      return {
        mode: state.mode,
        model: HYDROGEN_MODEL,
        chapterCount: state.outline.chapters.length,
      };
    });
  }
  async advance(runId: string, chapterNumber: number) {
    return this.locked(runId, async (signal) => {
      const { state, path } = await this.initialize(runId);
      logger.info('Advancing story text', {
        runId,
        storyId: state.storyId,
        mode: state.mode,
        chapterNumber,
      });
      if (chapterNumber > state.outline.chapters.length)
        throw Object.assign(new Error('Chapter outside outline'), { status: 400 });
      const save = () => saveTextCheckpoint(path, runId, state);
      const receipt = async () => {
        const steps = await this.runs.getRunSteps(runId);
        const detail = steps.find(
          (step) =>
            step.stepName === `write_chapter_${chapterNumber}` && step.status === 'completed',
        )?.detailJson as { chapterId: string; version?: number } | undefined;
        if (!detail) throw new Error('Chapter persistence receipt unavailable');
        const identity = await this.chapters.getPersistedIdentity(
          state.storyId,
          chapterNumber,
          detail.chapterId,
        );
        return {
          status: 'completed',
          mode: state.mode,
          chapterNumber,
          chapterId: identity.id,
          version: identity.version,
        };
      };
      if (state.completed.includes(chapterNumber)) return receipt();
      if (
        state.mode === 'chapter_by_chapter' &&
        Array.from({ length: chapterNumber - 1 }, (_, index) => index + 1).some(
          (number) => !state.completed.includes(number),
        )
      )
        throw Object.assign(new Error('Previous chapters missing from this run'), { status: 409 });
      const service = getAIGateway().getTextService();
      if (!(service instanceof GoogleGenAITextService))
        throw new Error('Durable story generation requires Hydrogen');
      if (
        !state.operation &&
        !state.drafts.some((chapter) => !state.completed.includes(chapter.chapterNumber))
      ) {
        const prompt =
          state.mode === 'whole_story' ? state.wholePrompt : state.prompts[chapterNumber - 1];
        if (!prompt) throw new Error('Chapter prompt unavailable');
        const history = state.drafts
          .filter((chapter) => chapter.chapterNumber < chapterNumber)
          .sort((a, b) => a.chapterNumber - b.chapterNumber)
          .map((chapter) => `Chapter ${chapter.chapterNumber}\n${chapter.htmlContent}`)
          .join('\n\n');
        const request = await service.prepareRequest(
          prompt.userPrompt.replace(
            '__SAVED_CHAPTER_HISTORY__',
            history || 'This is the first chapter.',
          ),
          {
            systemInstruction: prompt.systemInstruction,
            signal,
            thinkingLevel: 'high',
            maxTokens: state.mode === 'whole_story' ? state.wholeBudget : state.chapterBudget,
            ...(state.mode === 'whole_story' && { jsonSchema: wholeStorySchema }),
          },
        );
        state.operation = { request, parts: [], segment: 0 };
        await save();
      }
      const operation = state.operation;
      if (operation) {
        if (operation.pendingUsage) {
          await tokenUsageTrackingService.recordUsage(operation.pendingUsage, true);
          delete operation.pendingUsage;
          await save();
        }
        if (!operation.finishReason || operation.finishReason === 'CONTINUATION') {
          if (operation.segment >= 32) throw new Error('Continuation segment limit exceeded');
          if (operation.requestPending)
            throw Object.assign(
              new Error('Provider outcome unknown; operator reconciliation required'),
              { status: 409, code: 'PROVIDER_OUTCOME_UNKNOWN' },
            );
          signal.throwIfAborted();
          operation.requestPending = true;
          operation.requestedAt = new Date().toISOString();
          await save();
          const providerStarted = Date.now();
          let segment;
          try {
            segment = await service.generateSegment(operation.request, operation.token, signal);
          } catch (error) {
            const failure = error as {
              status?: number;
              code?: number | string;
              usage?: TextGenerationUsage;
            };
            if (failure.status === 422) {
              await this.runs.updateRun(runId, {
                status: 'blocked',
                failureStage: 'write_chapters',
                failureCode: 'safety_blocked',
                errorMessage: 'Story text blocked by safety policy',
              });
            }
            // A definitive rejected request can be retried; network outcomes stay uncertain.
            if (
              (failure.status != null &&
                [400, 401, 403, 404, 409, 422, 429, 500, 503].includes(failure.status)) ||
              typeof failure.code === 'number'
            )
              delete operation.requestPending;
            if (failure.usage?.inputTokens != null)
              operation.pendingUsage = this.usage(runId, state, operation.segment, failure.usage, {
                processingTimeMs: Date.now() - providerStarted,
                status: 'failed',
              });
            await save();
            if (operation.pendingUsage)
              await tokenUsageTrackingService.recordUsage(operation.pendingUsage, true);
            throw error;
          }
          delete operation.requestPending;
          operation.parts.push(...segment.parts);
          operation.finishReason = segment.finishReason;
          operation.segment++;
          if (segment.continuationToken) operation.token = segment.continuationToken;
          else delete operation.token;
          operation.pendingUsage = this.usage(runId, state, operation.segment, segment.usage, {
            processingTimeMs: Date.now() - providerStarted,
            finishReason: segment.finishReason,
          });
          await save();
          await tokenUsageTrackingService.recordUsage(operation.pendingUsage, true);
          delete operation.pendingUsage;
          await save();
          if (segment.finishReason === 'CONTINUATION' && segment.continuationToken)
            return { status: 'pending', mode: state.mode, chapterNumber };
        }
        try {
          if (operation.finishReason !== 'STOP') throw new Error('Incomplete model response');
          const text = operation.parts
            .filter((part) => !part.thought)
            .map((part) => part.text ?? '')
            .join('');
          if (state.mode === 'whole_story')
            state.drafts = validateWholeStory(
              text,
              state.outline.chapters.length,
              state.audience,
            ).map((chapter) => ({ ...chapter, id: randomUUID() }));
          else {
            validateChapterHtml(text, state.audience);
            state.drafts.push({ chapterNumber, htmlContent: text, id: randomUUID() });
          }
        } catch (error) {
          if (state.mode !== 'whole_story') throw error;
          state.mode = 'chapter_by_chapter';
          state.fallbackReason = 'invalid_or_incomplete_whole_story';
          delete state.operation;
          state.drafts = [];
          await save();
          return { status: 'pending', mode: state.mode, chapterNumber };
        }
        delete state.operation;
        await save();
      }
      for (const draft of state.drafts.filter(
        (chapter) => !state.completed.includes(chapter.chapterNumber),
      )) {
        signal.throwIfAborted();
        const outlineChapter = state.outline.chapters[draft.chapterNumber - 1];
        if (!outlineChapter) throw new Error('Chapter outside outline');
        const saved = await this.chapters.saveChapterOnce(
          {
            storyId: state.storyId,
            authorId: state.authorId,
            chapterNumber: draft.chapterNumber,
            title: outlineChapter.chapterTitle,
            htmlContent: draft.htmlContent,
          },
          draft.id,
        );
        await this.runs.storeStepResult(runId, `write_chapter_${draft.chapterNumber}`, {
          status: 'completed',
          result: {
            chapterNumber: draft.chapterNumber,
            chapter: draft.htmlContent,
            chapterTitle: outlineChapter.chapterTitle,
            chapterId: saved.id,
            version: saved.version,
          },
        });
        state.completed.push(draft.chapterNumber);
        await save();
      }
      if (state.completed.length === state.outline.chapters.length)
        await this.runs.storeStepResult(runId, 'text_generation_state', {
          status: 'completed',
          result: {
            path,
            mode: state.mode,
            originalMode: state.originalMode,
            model: HYDROGEN_MODEL,
            fallbackReason: state.fallbackReason ?? null,
          },
        });
      await new ProgressTrackerService().updateStoryProgress(runId);
      return receipt();
    });
  }
  private usage(
    runId: string,
    state: State,
    segment: number,
    usage: TextGenerationUsage,
    details: Record<string, unknown> = {},
  ): TokenUsageRequest {
    if (usage.inputTokens == null || usage.outputTokens == null)
      throw new Error('Hydrogen segment usage unavailable');
    return {
      tokenUsageId: randomUUID(),
      authorId: state.authorId,
      storyId: state.storyId,
      action: 'chapter_writing',
      aiModel: HYDROGEN_MODEL,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      inputPromptJson: {
        operation: state.mode === 'whole_story' ? 'whole_story_writing' : 'chapter_writing',
        runId,
        segment,
        mode: state.mode,
        usageSource: 'api',
        ...details,
        thinkingTokens: usage.thinkingTokens ?? 0,
      },
    };
  }
}
