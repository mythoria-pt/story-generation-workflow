/**
 * AI Gateway API Routes
 * Provider-agnostic endpoints for text and image generation
 */

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { validateImageRequest, generateImageFilename, formatImageError } from './ai-image-utils.js';
import { generateNextVersionFilename, extractFilenameFromUri } from '@/utils/imageUtils.js';
import { StoryService } from '@/services/story.js';
import { workflowErrorHandler } from '@/shared/workflow-error-handler.js';
import { PromptService } from '@/services/prompt.js';
import { SchemaService } from '@/services/schema.js';
import { getImageDimensions } from '@/utils/imageUtils.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { logger } from '@/config/logger.js';
import {
  formatTargetAudience,
  getLanguageName,
  parseAIResponse,
  prepareCharactersForPrompt,
} from '@/shared/utils.js';
import { CharacterService } from '@/services/characters.js';
import { eq } from 'drizzle-orm';
import {
  SUPPORTED_TRANSLATION_LOCALES,
  buildTranslatePrompt,
  cleanAITextOutput,
  normalizeSlug,
} from '@/services/translation.js';
import {
  CHARACTER_TYPES,
  CHARACTER_ROLES,
  CHARACTER_AGES,
  CHARACTER_TRAITS,
} from '@/shared/character-constants.js';
import { RunsService } from '@/services/runs.js';

// Initialize services
const router = Router();
const aiGateway = getAIGatewayWithTokenTracking();
const storyService = new StoryService();
const storageService = getStorageService();
const characterService = new CharacterService();
const runsService = new RunsService();

// Image prompt refinement helper (applies consistent best-practice formatting across providers)
function refineImagePrompt(
  raw: string,
  opts: { fallbackSubject?: string; styleHint?: string } = {},
): string {
  if (!raw || typeof raw !== 'string') {
    return opts.fallbackSubject || 'storybook illustration, soft lighting';
  }
  let p = raw
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/^\s+|\s+$/g, '')
    .replace(/^"|"$/g, ''); // trim quotes

  // Remove leading articles that add little value
  p = p.replace(/^(?:An?|The)\s+/i, '');

  // Ensure it describes a scene, not a command
  p = p.replace(/^Imagine\s+/, '');

  // Provide a gentle style hint if none present (avoid stacking many styles)
  const lower = p.toLowerCase();
  const styleProvided =
    /(illustration|digital painting|oil painting|watercolor|pixel art|anime|storybook|cinematic|render)/.test(
      lower,
    );
  const style = styleProvided ? '' : opts.styleHint || 'storybook illustration, soft lighting';

  // Cap length
  if (p.length > 600) {
    const cut = p.slice(0, 600);
    const lastPeriod = cut.lastIndexOf('.');
    p = lastPeriod > 60 ? cut.slice(0, lastPeriod + 1) : cut;
  }

  // Avoid trailing punctuation duplication (commas, semicolons, colons, dashes)
  // Hyphen does not need escaping inside the character class when placed first
  p = p.replace(/[-,;:]+$/, '').trim();

  return style ? `${p} – ${style}` : p;
}

function buildSafeFallbackPrompt(original: string, opts: { styleHint?: string } = {}): string {
  let prompt = original || '';

  // Generalize age/gender terms to be more neutral
  prompt = prompt.replace(/\b\d+\s*-?\s*month\s*-?\s*old\b/gi, 'young');
  prompt = prompt.replace(/\btoddler\b/gi, 'child');
  prompt = prompt.replace(/\bboy\b/gi, 'child');
  prompt = prompt.replace(/\bgirl\b/gi, 'child');

  // Ensure the scene is described as safe and wholesome
  if (!/safe|wholesome|cheerful/i.test(prompt)) {
    prompt += ' The scene is wholesome, safe, and cheerful.';
  }

  // Ensure characters are described as fully clothed
  if (!/clothed|wearing|dressed|outfit|attire/i.test(prompt)) {
    prompt += ' The character is fully clothed in appropriate daily attire.';
  }

  // Add lighting context if missing
  if (!/lighting|lit/i.test(prompt)) {
    prompt += ' Warm, gentle lighting.';
  }

  return refineImagePrompt(prompt, {
    styleHint: opts.styleHint || 'wholesome family illustration, soft lighting',
  });
}

// Shared outline + character schema definitions
const CharacterTypeEnum = z.enum(CHARACTER_TYPES);
const CharacterRoleEnum = z.enum(CHARACTER_ROLES);
const CharacterAgeEnum = z.enum(CHARACTER_AGES);
const CharacterTraitEnum = z.enum(CHARACTER_TRAITS);
const TargetAudienceEnum = z.enum([
  'children_0-2',
  'children_3-6',
  'children_7-10',
  'children_11-14',
  'young_adult_15-17',
  'adult_18+',
  'all_ages',
]);

const CharacterSchema = z.object({
  // AI may return empty string, null, or no characterId at all - we don't validate UUID format here
  characterId: z.string().nullable().optional(),
  name: z.string().min(1),
  type: CharacterTypeEnum.optional(),
  age: CharacterAgeEnum.optional(),
  traits: z.array(CharacterTraitEnum).max(5).optional(),
  characteristics: z.string().optional(),
  physicalDescription: z.string().optional(),
  role: CharacterRoleEnum.optional(),
});

export const OutlineSchema = z.object({
  bookTitle: z.string().min(1).trim(),
  'target-audience': TargetAudienceEnum,
  bookCoverPrompt: z.string().min(10).trim(),
  bookBackCoverPrompt: z.string().min(10).trim(),
  bookCoverCharacters: z.array(z.string().min(1)).default([]),
  bookBackCoverCharacters: z.array(z.string().min(1)).default([]),
  synopses: z.string().min(1).trim(),
  characters: z.array(CharacterSchema),
  chapters: z.array(
    z.object({
      chapterNumber: z.number().int().positive(),
      chapterTitle: z.string().min(1).trim(),
      chapterSynopses: z.string().min(1).trim(),
      chapterPhotoPrompt: z.string().min(10).trim(),
      charactersInScene: z.array(z.string().min(1)).default([]),
    }),
  ),
});

export type OutlineData = z.infer<typeof OutlineSchema>;

// Helper function to check if data matches outline structure
function isOutlineData(data: unknown): data is OutlineData {
  try {
    OutlineSchema.parse(data);
    return true;
  } catch (err) {
    if (err instanceof z.ZodError) {
      logger.error('Outline validation failed', {
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    return false;
  }
}

function hasNonEmptyCoverPrompts(data: OutlineData): boolean {
  const front = data.bookCoverPrompt?.trim();
  const back = data.bookBackCoverPrompt?.trim();
  return Boolean(front && back && front.length > 0 && back.length > 0);
}

// Request schemas
const OutlineRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid(),
});

const ChapterRequestSchema = z.object({
  storyId: z.string().uuid(),
  runId: z.string().uuid().optional(), // Optional for testing/development
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  chapterSynopses: z.string(),
  chapterCount: z.number().int().positive().optional(),
  outline: OutlineSchema.optional(),
  previousChapters: z.array(z.string()).optional(),
});

const SupportedTranslationLocaleEnum = z.enum(SUPPORTED_TRANSLATION_LOCALES);
const TranslationContentFormatEnum = z.enum(['markdown', 'mdx', 'html', 'text']);

const TranslationSegmentsSchema = z
  .object({
    slug: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(512).optional(),
    summary: z.string().min(1).max(2000).optional(),
    content: z.string().min(1).max(60000).optional(),
    contentFormat: TranslationContentFormatEnum.default('markdown'),
  })
  .refine((segments) => segments.slug || segments.title || segments.summary || segments.content, {
    message: 'Provide at least one segment to translate.',
    path: ['segments'],
  });

const TranslationMetadataSchema = z
  .object({
    requestedBy: z.string().min(2).max(128).optional(),
    references: z.array(z.string().min(1).max(200)).max(25).optional(),
    tone: z.string().max(200).optional(),
    notes: z.string().max(500).optional(),
  })
  .optional();

const TranslateRequestSchema = z.object({
  requestId: z.string().optional(),
  resourceId: z.string().optional(),
  storyTitle: z.string().optional(),
  sourceLocale: z.literal('en-US').default('en-US'),
  targetLocales: z
    .array(SupportedTranslationLocaleEnum)
    .min(1)
    .refine((locales) => new Set(locales).size === locales.length, {
      message: 'targetLocales must be unique.',
      path: ['targetLocales'],
    }),
  segments: TranslationSegmentsSchema,
  metadata: TranslationMetadataSchema,
});

type TranslationContentFormat = z.infer<typeof TranslationContentFormatEnum>;

function describeExtraContext(metadata?: z.infer<typeof TranslationMetadataSchema>): string {
  if (!metadata) return '';
  const parts: string[] = [];
  if (metadata.references?.length) {
    parts.push(`Key references to preserve or adapt: ${metadata.references.join(', ')}`);
  }
  if (metadata.tone) {
    parts.push(`Desired tone: ${metadata.tone}`);
  }
  if (metadata.notes) {
    parts.push(metadata.notes);
  }
  return parts.join(' | ');
}

function resolveContentType(
  format: TranslationContentFormat,
): 'html' | 'text' | 'markdown' | 'mdx' {
  switch (format) {
    case 'html':
      return 'html';
    case 'text':
      return 'text';
    case 'mdx':
      return 'mdx';
    default:
      return 'markdown';
  }
}

/**
 * POST /ai/text/outline
 * Generate story outline using AI text generation with story context from database
 */
router.post('/text/outline', async (req, res) => {
  try {
    const { storyId, runId } = OutlineRequestSchema.parse(req.body);

    // Load story context from database with enhanced error handling
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      // Use the workflow error handler for better diagnostics
      const workflowError = await workflowErrorHandler.handleStoryNotFound(storyId, runId);
      workflowErrorHandler.logWorkflowError(workflowError);

      const statusCode = workflowError.type === 'ORPHANED_RUN' ? 404 : 500;
      res.status(statusCode).json(workflowErrorHandler.createErrorResponse(workflowError));
      return;
    } // Load prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-outline'); // Use the chapterCount from the database, fallback to 6 if not available
    const chapterCount = storyContext.story.chapterCount || 6;

    // Prepare template variables
    const templateVars = {
      novelStyle: storyContext.story.novelStyle || 'adventure',
      targetAudience: formatTargetAudience(storyContext.story.targetAudience),
      place: storyContext.story.place || 'a magical land',
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount,
      characters: prepareCharactersForPrompt(storyContext.characters),
      bookTitle: storyContext.story.title,
      storyDescription:
        storyContext.story.plotDescription ||
        storyContext.story.synopsis ||
        'No description provided',
      description: storyContext.story.plotDescription || 'No specific plot description provided.',
      graphicalStyle: storyContext.story.graphicalStyle || 'colorful and vibrant illustration',
      // Placeholder values for template completion
      bookCoverPrompt: 'A book cover prompt will be generated',
      bookBackCoverPrompt: 'A back cover prompt will be generated',
      synopses: 'Story synopsis will be generated',
      chapterNumber: '1',
      chapterPhotoPrompt: 'Chapter illustration prompt will be generated',
      chapterTitle: 'Chapter title will be generated',
      chapterSynopses: 'Chapter synopsis will be generated',
    };

    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);

    // Load JSON schema for structured output
    const storyOutlineSchema = await SchemaService.loadSchema('story-outline'); // Generate outline using AI with specific outline model and JSON schema
    // Use model based on configured text provider
    let outlineModel: string;
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';

    if (textProvider === 'openai') {
      outlineModel = process.env.OPENAI_TEXT_MODEL || 'gpt-5';
    } else if (textProvider === 'google-genai') {
      outlineModel = process.env.GOOGLE_GENAI_MODEL || 'gemini-2.5-flash';
    } else {
      outlineModel = 'gpt-5';
    }
    const requestOptions = {
      temperature: 1,
      model: outlineModel,
      jsonSchema: storyOutlineSchema,
    }; // Create context for token tracking
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'story_outline' as const,
    };

    // Use a deterministic contextId across the workflow (storyId + runId)
    const contextId = `${storyId}:${runId}`;

    const runSingleOutlineAttempt = async (): Promise<OutlineData> => {
      const outline = await aiGateway.getTextService(aiContext).complete(finalPrompt, {
        ...requestOptions,
        contextId, // ensure the outline response (as first turn) is bound to a context
      });

      const parsedData = parseAIResponse(outline);

      if (!isOutlineData(parsedData)) {
        const dataAsRecord =
          parsedData && typeof parsedData === 'object'
            ? (parsedData as Record<string, unknown>)
            : {};
        logger.error('Invalid outline structure', {
          hasBookTitle: !!dataAsRecord?.bookTitle,
          hasChapters: !!dataAsRecord?.chapters,
          isChaptersArray: Array.isArray(dataAsRecord?.chapters),
          actualKeys: Object.keys(dataAsRecord),
        });
        throw new Error('Invalid outline structure received');
      }

      const outlineData = parsedData;

      // Refine cover + chapter image prompts for cross-provider clarity
      try {
        if (outlineData.bookCoverPrompt) {
          outlineData.bookCoverPrompt = refineImagePrompt(outlineData.bookCoverPrompt, {
            styleHint: 'vibrant cover illustration, detailed, soft lighting',
          });
          const title = storyContext.story.title?.trim();
          if (title) {
            outlineData.bookCoverPrompt = `${outlineData.bookCoverPrompt} Include the exact book title text "${title}" prominently on the cover.`;
          }
        }
        if (outlineData.bookBackCoverPrompt) {
          outlineData.bookBackCoverPrompt = refineImagePrompt(outlineData.bookBackCoverPrompt, {
            styleHint: 'cohesive back cover illustration, soft lighting',
          });
        }
        if (Array.isArray(outlineData.chapters)) {
          outlineData.chapters = outlineData.chapters.map((ch) => ({
            ...ch,
            chapterPhotoPrompt: refineImagePrompt(ch.chapterPhotoPrompt, {
              styleHint: 'cohesive interior illustration, soft lighting',
            }),
          }));
        }
      } catch (refErr) {
        logger.warn('Prompt refinement failed (non-fatal)', {
          error: refErr instanceof Error ? refErr.message : String(refErr),
        });
      }

      return outlineData;
    };

    let outlineData: OutlineData | null = null;
    let lastError: unknown;

    for (const attempt of [1, 2]) {
      try {
        const attemptResult = await runSingleOutlineAttempt();

        if (!hasNonEmptyCoverPrompts(attemptResult)) {
          throw new Error('Outline missing cover prompts');
        }

        outlineData = attemptResult;
        break;
      } catch (err) {
        lastError = err;

        if (attempt === 1) {
          logger.warn('Outline attempt failed, clearing stale outline step and retrying once', {
            storyId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });

          try {
            await runsService.deleteStepResult(runId, 'generate_outline');
          } catch (deleteErr) {
            logger.warn('Failed to clear outline step before retry', {
              storyId,
              runId,
              error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
            });
          }

          continue;
        }
      }
    }

    if (!outlineData) {
      throw lastError instanceof Error
        ? lastError
        : new Error('Failed to generate outline after retry');
    }

    // Initialize chat context after successful outline (system prompt = condensed outline summary)
    try {
      const condensedOutline =
        `BOOK TITLE: ${outlineData.bookTitle}\nCHAPTERS: ${outlineData.chapters.map((c) => `${c.chapterNumber}. ${c.chapterTitle}`).join(' | ')}`.slice(
          0,
          3500,
        );
      // Initialize generic context manager (in-memory) then provider-specific chat
      const { contextManager } = await import('@/ai/context-manager.js');
      const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
      await contextManager.initializeContext(contextId, storyId, condensedOutline);
      if (textProvider === 'google-genai') {
        // Initialize provider chat instance (will attach to existing context)
        const textService = aiGateway.getTextService(aiContext) as any;
        if (typeof textService.initializeContext === 'function') {
          await textService.initializeContext(contextId, condensedOutline);
        }
      }
    } catch (ctxErr) {
      logger.warn('Failed to initialize outline context', {
        error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr),
        storyId,
        runId,
      });
    }

    res.json({
      success: true,
      storyId,
      runId,
      outline: outlineData,
      storyContext: {
        title: storyContext.story.title,
        charactersCount: storyContext.characters.length,
        contextId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /ai/text/structure
 * Generate structured story + characters from free text (text-only for now)
 */
router.post('/text/structure', async (req, res) => {
  try {
    const RequestSchema = z.object({
      storyId: z.string().uuid(),
      userDescription: z.string().optional(),
      imageData: z.string().nullable().optional(), // legacy base64 (discouraged)
      audioData: z.string().nullable().optional(), // legacy base64 (discouraged)
      imageObjectPath: z.string().optional(), // preferred: object path in bucket
      audioObjectPath: z.string().optional(),
      characterIds: z.array(z.string().uuid()).optional(), // optional array of character IDs to include
    });

    const {
      storyId,
      userDescription,
      imageObjectPath,
      audioObjectPath,
      imageData,
      audioData,
      characterIds,
    } = RequestSchema.parse(req.body);
    logger.info('AI Text Structure: request received', {
      storyId,
      hasText: !!userDescription,
      hasImage: !!req.body?.imageData || !!imageObjectPath,
      hasAudio: !!req.body?.audioData || !!audioObjectPath,
      characterIdsCount: characterIds?.length || 0,
    });

    // Get story and author
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      logger.warn('AI Text Structure: story not found', { storyId });
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }

    // Load specified characters (if any)
    let existingCharacters: any[] = [];
    if (characterIds && characterIds.length > 0) {
      // Load only the specified characters and verify they belong to the author
      const requestedCharacters = await characterService.getCharactersByIds(characterIds);
      existingCharacters = requestedCharacters.filter(
        (char) => char.authorId === storyContext.story.authorId,
      );

      // Log if some characters were filtered out for security
      if (existingCharacters.length !== characterIds.length) {
        logger.warn("Some requested characters don't belong to the author", {
          requestedCount: characterIds.length,
          validCount: existingCharacters.length,
          authorId: storyContext.story.authorId,
        });
      }
    }

    // Build prompt
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-structure');
    const templateVars = {
      authorName: '',
      userDescription: userDescription ?? '',
      existingCharacters: JSON.stringify(
        existingCharacters.map((c) => ({
          characterId: c.characterId,
          name: c.name,
          type: c.type ?? undefined,
          role: undefined,
          characteristics: c.characteristics ?? undefined,
          physicalDescription: c.physicalDescription ?? undefined,
        })),
      ),
    };
    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);
    const structSchema = await SchemaService.loadSchema('story-structure');

    // Model selection
    let model: string;
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
    if (textProvider === 'openai') {
      model = process.env.OPENAI_TEXT_MODEL || 'gpt-5';
    } else {
      model = process.env.GOOGLE_GENAI_MODEL || 'gemini-2.5-flash';
    }

    // Token tracking context
    const aiContext = {
      authorId: storyContext.story.authorId,
      storyId,
      action: 'story_structure' as const,
    };

    // Build media parts if we can use Gemini multimodal
    let aiResponse: string;
    const hasB64Image = typeof imageData === 'string' && imageData.length > 0;
    const hasB64Audio = typeof audioData === 'string' && audioData.length > 0;
    const canUseGemini =
      textProvider === 'google-genai' &&
      (imageObjectPath || audioObjectPath || hasB64Image || hasB64Audio);
    if (canUseGemini) {
      const storage = getStorageService();
      const mediaParts: Array<{ mimeType: string; data: Buffer | string }> = [];
      if (imageObjectPath) {
        const meta = await storage
          .getFileMetadata(imageObjectPath)
          .catch(() => ({ contentType: 'image/jpeg' }));
        const buf = await storage.downloadFileAsBuffer(imageObjectPath);
        mediaParts.push({
          mimeType: meta.contentType || 'image/jpeg',
          data: buf,
        });
      }
      if (audioObjectPath) {
        const meta = await storage
          .getFileMetadata(audioObjectPath)
          .catch(() => ({ contentType: 'audio/wav' }));
        const buf = await storage.downloadFileAsBuffer(audioObjectPath);
        mediaParts.push({
          mimeType: meta.contentType || 'audio/wav',
          data: buf,
        });
      }
      // Fallback: attach base64 media directly (dev-friendly, no GCS needed)
      if (hasB64Image) {
        const str = imageData as string;
        let mime = 'image/jpeg';
        let b64 = str;
        const match = /^data:([^;]+);base64,(.*)$/.exec(str);
        if (match) {
          mime = (match[1] as string) || mime;
          b64 = (match[2] as string) || b64;
        }
        mediaParts.push({ mimeType: mime, data: Buffer.from(b64, 'base64') });
      }
      if (hasB64Audio) {
        const str = audioData as string;
        let mime = 'audio/wav';
        let b64 = str;
        const match = /^data:([^;]+);base64,(.*)$/.exec(str);
        if (match) {
          mime = (match[1] as string) || mime;
          b64 = (match[2] as string) || b64;
        }
        mediaParts.push({ mimeType: mime, data: Buffer.from(b64, 'base64') });
      }
      aiResponse = await aiGateway.getTextService(aiContext).complete(finalPrompt, {
        temperature: 0.8,
        model,
        jsonSchema: structSchema,
        mediaParts,
      } as any);
    } else {
      aiResponse = await aiGateway.getTextService(aiContext).complete(finalPrompt, {
        temperature: 0.8,
        model,
        jsonSchema: structSchema,
      });
    }

    const parsed = parseAIResponse(aiResponse) as any;

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.story ||
      !Array.isArray(parsed.characters)
    ) {
      logger.error('Invalid structure response', {
        receivedKeys: parsed ? Object.keys(parsed) : null,
      });
      res.status(500).json({ success: false, error: 'Invalid structured response from AI' });
      return;
    }

    // Persist story fields (subset already used by app)
    const updates: Record<string, unknown> = {};
    if (parsed.story.title) updates.title = parsed.story.title;
    if (parsed.story.plotDescription) updates.plotDescription = parsed.story.plotDescription;
    if (parsed.story.synopsis) updates.synopsis = parsed.story.synopsis;
    if (parsed.story.place) updates.place = parsed.story.place;
    if (parsed.story.additionalRequests)
      updates.additionalRequests = parsed.story.additionalRequests;
    if (parsed.story.targetAudience) updates.targetAudience = parsed.story.targetAudience;
    if (parsed.story.novelStyle) updates.novelStyle = parsed.story.novelStyle;
    if (parsed.story.graphicalStyle) updates.graphicalStyle = parsed.story.graphicalStyle;
    if (parsed.story.storyLanguage) updates.storyLanguage = parsed.story.storyLanguage;

    // Direct DB update via webapp schema synced to SGW
    try {
      const { getDatabase } = await import('@/db/connection.js');
      const { stories } = await import('@/db/schema/index.js');
      await getDatabase()
        .update(stories)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(stories.storyId, storyId));
    } catch (dbErr) {
      logger.error('Failed updating story with structured fields', {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      // Continue; characters can still be created/linked
    }

    // Characters create/reuse + link
    const processedCharacters: any[] = [];
    for (const ch of parsed.characters as any[]) {
      let record: any | null = null;
      // Only accept UUIDs; models may emit placeholders like "character_1"
      const isUuid =
        typeof ch.characterId === 'string' &&
        /^(?!00000000-0000-0000-0000-000000000000)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
          ch.characterId,
        );
      if (isUuid) {
        try {
          record = await characterService.getCharacterById(ch.characterId);
        } catch (e) {
          logger.warn('Invalid or not found characterId; creating new character', {
            providedId: ch.characterId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!record) {
        // Keep photoUrl only if it points to our GCS bucket; drop external links (e.g., imgur)
        let safePhotoUrl: string | undefined;
        if (typeof ch.photoUrl === 'string') {
          try {
            const u = new URL(ch.photoUrl);
            const isGcs = u.hostname === 'storage.googleapis.com';
            const bucket = process.env.STORAGE_BUCKET_NAME;
            if (isGcs && bucket && u.pathname.startsWith(`/${bucket}/`)) {
              safePhotoUrl = ch.photoUrl;
            }
          } catch {
            // ignore invalid URLs
          }
        }
        const createPayload: any = {
          name: ch.name,
          authorId: storyContext.story.authorId,
          type: ch.type,
          role: ch.role,
          age: ch.age,
          traits: Array.isArray(ch.traits) ? ch.traits : undefined,
          characteristics: ch.characteristics,
          physicalDescription: ch.physicalDescription,
        };
        if (safePhotoUrl) createPayload.photoUrl = safePhotoUrl;
        record = await characterService.createCharacter(createPayload);
      }
      if (record) {
        try {
          await characterService.addCharacterToStory(storyId, record.characterId, ch.role);
        } catch (linkErr) {
          logger.warn('Character may already be linked to story', {
            storyId,
            characterId: record.characterId,
            error: linkErr instanceof Error ? linkErr.message : String(linkErr),
          });
        }
        processedCharacters.push({ ...record, role: ch.role ?? undefined });
      }
    }

    res.json({
      success: true,
      storyId,
      story: { ...updates, storyId },
      characters: processedCharacters,
      originalInput: userDescription ?? '',
      hasImageInput: false,
      hasAudioInput: false,
      message: 'Story structure generated successfully.',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /ai/media/signed-upload
 * Request a V4 signed URL for direct browser upload to GCS
 * Body: { storyId: uuid, filename?: string, contentType: string, kind: 'image'|'audio' }
 * Stores under mythoria-generated-stories/{storyId}/inputs/<filename>
 */
router.post('/media/character-photo', async (req, res) => {
  try {
    const Schema = z.object({
      authorId: z.string().uuid(),
      characterId: z.string().uuid(),
      dataUrl: z.string().min(10),
    });
    const { authorId, characterId, dataUrl } = Schema.parse(req.body);

    const match = /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl.trim());
    if (!match || !match[1]) {
      res.status(400).json({
        success: false,
        error: 'Invalid dataUrl format; expected data:image/jpeg;base64,...',
      });
      return;
    }

    const base64Payload = match[1];
    const buffer = Buffer.from(base64Payload, 'base64');
    const objectPath = `characters/${authorId}/${characterId}.jpg`;

    const publicUrl = await storageService.uploadFile(objectPath, buffer, 'image/jpeg', {
      cacheControl: 'public, max-age=31536000',
    });

    res.json({ success: true, publicUrl, gcsPath: objectPath });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to upload character photo', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({ success: false, error: 'Failed to upload character photo' });
  }
});

router.delete('/media/character-photo', async (req, res) => {
  try {
    const Schema = z.object({
      gcsPath: z.string().min(1),
    });
    const { gcsPath } = Schema.parse(req.body);

    const normalizedPath = gcsPath.trim();
    const isCharactersPath = normalizedPath.startsWith('characters/');
    const hasTraversal = normalizedPath.includes('..');
    if (!isCharactersPath || hasTraversal) {
      res.status(400).json({
        success: false,
        error: 'Invalid gcsPath; must start with characters/ and not contain ..',
      });
      return;
    }

    const exists = await storageService.fileExists(normalizedPath);
    if (exists) {
      await storageService.deleteFile(normalizedPath);
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to delete character photo', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({ success: false, error: 'Failed to delete character photo' });
  }
});

/**
 * POST /ai/media/analyze-character-photo
 * Analyzes a character photo using GenAI and returns a 2-sentence physical description.
 * Body: { dataUrl: string (base64 JPEG), locale: string (e.g. 'en-US', 'pt-PT') }
 * Returns: { success: true, description: string } or { success: false, error: string }
 */
router.post('/media/analyze-character-photo', async (req, res) => {
  const REQUEST_TIMEOUT_MS = 50000; // 50 seconds timeout

  try {
    const Schema = z.object({
      dataUrl: z.string().min(10),
      locale: z.string().min(2).max(10),
    });
    const { dataUrl, locale } = Schema.parse(req.body);

    // Validate dataUrl format
    const match = /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl.trim());
    if (!match || !match[1]) {
      res.status(400).json({
        success: false,
        error: 'Invalid dataUrl format; expected data:image/jpeg;base64,...',
      });
      return;
    }

    const base64Payload = match[1];
    const buffer = Buffer.from(base64Payload, 'base64');

    // Get the language name for the prompt
    const languageName = getLanguageName(locale);

    // Load prompt template from file
    const promptTemplate = await PromptService.loadSharedPrompt('character-photo-analysis');
    const variables = { languageName, locale };
    const systemPrompt = promptTemplate.systemPrompt
      ? PromptService.processPrompt(promptTemplate.systemPrompt, variables)
      : '';
    const userPrompt = PromptService.processPrompt(promptTemplate.userPrompt, variables);

    logger.info('Analyzing character photo', { locale, languageName });

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Analysis request timed out')), REQUEST_TIMEOUT_MS);
    });

    // Get the text service and make the multimodal request
    const textService = aiGateway.getTextService({
      authorId: 'system',
      storyId: 'character-photo-analysis',
      action: 'character_photo_analysis',
    });

    // Gemini 3 specific configuration:
    // - temperature: 1.0 is strongly recommended for Gemini 3 (lower values can cause looping/degraded performance)
    // - thinkingLevel: 'low' to minimize latency for this simple descriptive task
    // - mediaResolution: 'medium' is sufficient for character description (saves tokens vs 'high' default)
    // - maxTokens: 2048 to accommodate any thinking overhead plus output
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
    const analysisPromise = textService.complete(fullPrompt, {
      mediaParts: [{ mimeType: 'image/jpeg', data: buffer }],
      temperature: 1.0, // Gemini 3 recommended default (lower values can cause issues)
      maxTokens: 2048, // Accommodate thinking overhead + output
      thinkingLevel: 'low', // Minimize latency for simple descriptive task
      mediaResolution: 'medium', // Sufficient for character description, saves tokens
    });

    // Race the analysis against the timeout
    const description = await Promise.race([analysisPromise, timeoutPromise]);

    // Clean up the response (remove any markdown, extra whitespace, etc.)
    const cleanedDescription = description
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes if any
      .replace(/^\*+|\*+$/g, '') // Remove markdown bold markers
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim();

    logger.info('Character photo analysis completed', {
      locale,
      descriptionLength: cleanedDescription.length,
    });

    res.json({ success: true, description: cleanedDescription });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to analyze character photo', { error: errorMessage });

    // Check if it's a timeout error
    if (errorMessage.includes('timed out')) {
      res.status(504).json({ success: false, error: 'Analysis request timed out. Please try again.' });
      return;
    }

    res.status(500).json({ success: false, error: 'Failed to analyze character photo' });
  }
});

/**
 * POST /ai/media/upload
 * Server-side upload: accepts base64 data and stores in GCS. No signed URLs.
 * Body: { storyId: uuid, kind: 'image'|'audio', contentType: string, filename?: string, dataUrl: string }
 */
router.post('/media/upload', async (req, res) => {
  try {
    const Schema = z.object({
      storyId: z.string().uuid(),
      kind: z.enum(['image', 'audio']),
      contentType: z.string().min(3),
      filename: z.string().optional(),
      dataUrl: z.string().min(10),
    });
    const { storyId, kind, contentType, filename, dataUrl } = Schema.parse(req.body);

    // Ensure story exists
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }

    // Decode data URL or raw base64
    let mime = contentType;
    let b64 = dataUrl;
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (match) {
      mime = (match[1] as string) || contentType;
      b64 = (match[2] as string) || dataUrl;
    }
    const buffer = Buffer.from(b64, 'base64');

    // Build object path and upload
    const folder = `${storyId}/inputs`;
    const defaultExt = kind === 'image' ? 'jpg' : 'wav';
    const safeName =
      filename && filename.trim().length > 0 ? filename : `${kind}-${Date.now()}.${defaultExt}`;
    const objectPath = `${folder}/${safeName}`;

    const publicUrl = await storageService.uploadFile(objectPath, buffer, mime);

    res.json({ success: true, storyId, kind, objectPath, publicUrl });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /ai/media/story-image-upload
 * Upload a user-provided image as a new versioned story image (front/back cover or chapter)
 * Body: { storyId, imageType: 'cover'|'backcover'|'chapter', chapterNumber?, contentType, dataUrl, currentImageUrl? }
 * - currentImageUrl: existing HTTPS (or gs://) URL used to compute next version; if absent uses _v001 baseline
 * - Always stores under {storyId}/images/
 */
router.post('/media/story-image-upload', async (req, res) => {
  try {
    const Schema = z.object({
      storyId: z.string().uuid(),
      imageType: z.enum(['cover', 'backcover', 'chapter']),
      chapterNumber: z.number().int().positive().optional(),
      contentType: z.string().min(3),
      dataUrl: z.string().min(10),
      currentImageUrl: z.string().optional(),
    });
    const { storyId, imageType, chapterNumber, contentType, dataUrl, currentImageUrl } =
      Schema.parse(req.body);

    // Validate story
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }
    if (imageType === 'chapter' && !chapterNumber) {
      res.status(400).json({ success: false, error: 'chapterNumber required for chapter image' });
      return;
    }

    // Decode data URL
    let mime = contentType;
    let b64 = dataUrl;
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (match) {
      mime = (match[1] as string) || contentType;
      b64 = (match[2] as string) || dataUrl;
    }
    const buffer = Buffer.from(b64, 'base64');

    // Determine base filename
    let nextFullUrl: string;
    if (currentImageUrl && /_v\d{3}\./.test(currentImageUrl)) {
      // Increment version using existing utility
      nextFullUrl = generateNextVersionFilename(currentImageUrl);
    } else {
      // First version baseline (_v001)
      const mappedType =
        imageType === 'cover'
          ? 'front_cover'
          : imageType === 'backcover'
            ? 'back_cover'
            : 'chapter';
      nextFullUrl = chapterNumber
        ? generateImageFilename({ storyId, imageType: mappedType as any, chapterNumber })
        : generateImageFilename({ storyId, imageType: mappedType as any });
    }
    // Extract object path (strip bucket/domain)
    const objectPath = extractFilenameFromUri(nextFullUrl);
    if (!objectPath.startsWith(`${storyId}/images/`)) {
      // Safety guard: enforce images folder
      const filename = objectPath.split('/').pop() || 'image_v001.jpg';
      nextFullUrl = `https://storage.googleapis.com/${process.env.STORAGE_BUCKET_NAME || 'mythoria-generated-stories'}/${storyId}/images/${filename}`;
    }
    const finalObjectPath = extractFilenameFromUri(nextFullUrl);

    const publicUrl = await storageService.uploadFile(finalObjectPath, buffer, mime);

    res.json({ success: true, storyId, imageType, objectPath: finalObjectPath, publicUrl });
  } catch (error) {
    res
      .status(400)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /ai/text/chapter/:chapterNumber
 * Generate a specific chapter using AI text generation
 */
router.post('/text/chapter/:chapterNumber', async (req, res) => {
  try {
    const chapterNumber = parseInt(req.params.chapterNumber);
    const requestData = { ...req.body, chapterNumber };
    const { storyId, runId, chapterTitle, chapterSynopses, chapterCount } =
      ChapterRequestSchema.parse(requestData);
    const contextId = `${storyId}:${runId}`;

    // Validate chapter number if outline is provided
    if (req.body.outline?.chapters && Array.isArray(req.body.outline.chapters)) {
      const maxChapters = req.body.outline.chapters.length;
      if (chapterNumber < 1 || chapterNumber > maxChapters) {
        res.status(400).json({
          success: false,
          error: `Invalid chapter number ${chapterNumber}. Must be between 1 and ${maxChapters}.`,
        });
        return;
      }
    }

    // Get story context from database
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    } // Load chapter prompt template and prepare variables
    const promptTemplate = await PromptService.loadPrompt('en-US', 'text-chapter');

    // Prepare template variables
    const hookInstruction =
      chapterCount && chapterNumber < chapterCount
        ? 'If relevant, you may end with a hook for the next chapter.'
        : '';

    const templateVariables = {
      chapterNumber: chapterNumber.toString(),
      chapterTitle: chapterTitle,
      novelStyle: storyContext.story.novelStyle || 'adventure',
      averageAge: formatTargetAudience(storyContext.story.targetAudience),
      description: storyContext.story.plotDescription || storyContext.story.synopsis || '',
      chapterSynopses: chapterSynopses,
      language: getLanguageName(storyContext.story.storyLanguage),
      chapterCount: chapterCount?.toString() || '10',
      hookInstruction: hookInstruction,
    };

    // Build dynamic memory (previous chapters) heuristic: fetch saved chapters < current
    let memoryBlock = '';
    try {
      if (chapterNumber > 1) {
        const { ChaptersService } = await import('@/services/chapters.js');
        const chaptersService = new ChaptersService();
        const existing = await chaptersService.getStoryChapters(storyId);
        const prior = existing.filter((c) => c.chapterNumber < chapterNumber);

        prior.sort((a, b) => a.chapterNumber - b.chapterNumber);
        if (prior.length > 0) {
          const toPlainText = (html: string) =>
            html
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

          const summarize = (html: string) => {
            const plain = toPlainText(html);
            // Prefer the last part of the chapter to maintain continuity
            // If the text is short enough, return it all
            if (plain.length <= 1500) {
              return plain;
            }

            // Otherwise, try to get the last few sentences
            const sentences = plain.split(/(?<=[.!?])\s+/).filter((segment) => segment.length > 0);
            const lastSentences = sentences.slice(-10).join(' ');

            if (lastSentences.length >= 300 && lastSentences.length <= 2000) {
              return '...' + lastSentences;
            }

            // Fallback to simple slicing from the end
            return '...' + plain.slice(-1500);
          };

          const earlier = prior.slice(0, Math.max(0, prior.length - 2));
          const recent = prior.slice(-2);

          const summaryEntries = earlier.map((chapter) => ({
            chapterNumber: chapter.chapterNumber,
            summary: summarize(chapter.htmlContent),
          }));

          const recentEntries = recent.map((chapter) => ({
            chapterNumber: chapter.chapterNumber,
            full: toPlainText(chapter.htmlContent),
            summary: summarize(chapter.htmlContent),
            mode: 'full' as 'full' | 'summary',
          }));

          let outlineOverview = req.body.outline?.chapters
            ? req.body.outline.chapters
                .map((c: any) => `${c.chapterNumber}. ${c.chapterTitle}`)
                .join(' | ')
            : '';

          let continuityNote = `You are now writing Chapter ${chapterNumber}. Maintain continuity with prior chapters.`;
          const maxChars = parseInt(process.env.STORY_CONTEXT_MAX_CHARS || '12000', 10);

          const serializeSection = () => {
            const sections: string[] = [];

            if (outlineOverview) {
              sections.push(`  <outline_overview>${outlineOverview}</outline_overview>`);
            }

            if (summaryEntries.length > 0) {
              const summaries = summaryEntries
                .map(
                  (entry) =>
                    `    <chapter_summary number="${entry.chapterNumber}">${entry.summary}</chapter_summary>`,
                )
                .join('\n');
              sections.push(
                [
                  '  <previous_chapter_summaries>',
                  summaries,
                  '  </previous_chapter_summaries>',
                ].join('\n'),
              );
            }

            if (recentEntries.length > 0) {
              const recents = recentEntries
                .map((entry) => {
                  const tag = entry.mode === 'full' ? 'chapter_full' : 'chapter_summary';
                  const content = entry.mode === 'full' ? entry.full : entry.summary;
                  return `    <${tag} number="${entry.chapterNumber}">${content}</${tag}>`;
                })
                .join('\n');
              sections.push(['  <recent_chapters>', recents, '  </recent_chapters>'].join('\n'));
            }

            if (continuityNote) {
              sections.push(`  <continuity_note>${continuityNote}</continuity_note>`);
            }

            if (sections.length === 0) {
              return '';
            }

            return `<story_context>\n${sections.join('\n')}\n</story_context>`;
          };

          let serialized = serializeSection();
          let iterations = 0;

          while (serialized && serialized.length > maxChars && iterations < 20) {
            iterations += 1;
            let changed = false;

            if (summaryEntries.length > 0) {
              summaryEntries.shift();
              changed = true;
            } else {
              const fullEntry = recentEntries.find((entry) => entry.mode === 'full');
              if (fullEntry && fullEntry.summary.length > 0) {
                fullEntry.mode = 'summary';
                changed = true;
              } else if (outlineOverview) {
                outlineOverview = '';
                changed = true;
              } else if (continuityNote.length > 0) {
                continuityNote = '';
                changed = true;
              }
            }

            if (!changed) {
              break;
            }

            serialized = serializeSection();
          }

          if (serialized && serialized.length > 0) {
            if (serialized.length > maxChars) {
              const truncated = serialized.slice(serialized.length - maxChars);
              memoryBlock = `<story_context_truncated>${truncated}</story_context_truncated>`;
              logger.warn('Story context exceeded max characters, using truncated block', {
                storyId,
                runId,
                chapterNumber,
                maxChars,
                serializedLength: serialized.length,
              });
            } else {
              memoryBlock = serialized;
            }
          }
        }
      }
    } catch (memErr) {
      logger.warn('Failed building chapter memory', {
        storyId,
        runId,
        chapterNumber,
        error: memErr instanceof Error ? memErr.message : String(memErr),
      });
    }

    // Build the complete prompt with memory block
    const basePrompt = PromptService.buildPrompt(promptTemplate, templateVariables);
    const chapterPrompt = memoryBlock ? `${memoryBlock}\n\n${basePrompt}` : basePrompt;

    // Create context for token tracking
    const chapterContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'chapter_writing' as const,
    };

    // Generate chapter content
    const chapterText = await aiGateway.getTextService(chapterContext).complete(chapterPrompt, {
      temperature: 1,
      contextId,
    });

    res.json({
      success: true,
      storyId,
      runId: runId || null,
      chapterNumber,
      chapter: chapterText.trim(),
      contextId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/text/translate', async (req, res) => {
  try {
    const payload = TranslateRequestSchema.parse(req.body);
    const requestId = payload.requestId || randomUUID();

    const targetLocales = payload.targetLocales.filter((locale) => locale !== payload.sourceLocale);
    if (targetLocales.length === 0) {
      res.status(400).json({
        success: false,
        error: 'At least one target locale must differ from the source locale.',
        requestId,
      });
      return;
    }

    const translations: Record<
      string,
      {
        slug?: string;
        title?: string;
        summary?: string;
        content?: string;
        contentFormat?: TranslationContentFormat;
      }
    > = {};
    const notices: Record<string, string[]> = {};
    const extraContext = describeExtraContext(payload.metadata);
    const baseAuthorId = payload.metadata?.requestedBy?.trim() || 'admin-portal';
    const baseStoryId = payload.resourceId?.trim() || 'blog';
    const contentFormat = payload.segments.contentFormat;
    const contentType = resolveContentType(contentFormat);
    const segmentSources = {
      slug: payload.segments.slug?.trim(),
      title: payload.segments.title?.trim(),
      summary: payload.segments.summary?.trim(),
      content: payload.segments.content?.trim(),
    } as const;

    for (const locale of targetLocales) {
      const localeNotices: string[] = [];
      try {
        const aiContext = {
          authorId: baseAuthorId,
          storyId: `${baseStoryId}:${locale}`,
          action: 'blog_translation' as const,
        };
        const textService = aiGateway.getTextService(aiContext);
        const localeResult: {
          slug?: string;
          title?: string;
          summary?: string;
          content?: string;
          contentFormat?: TranslationContentFormat;
        } = {};

        if (segmentSources.slug) {
          const slugPrompt = await buildTranslatePrompt(locale, {
            contentType: 'slug',
            originalText: segmentSources.slug,
            ...(payload.storyTitle && { storyTitle: payload.storyTitle }),
            sourceLocale: payload.sourceLocale,
            extraContext,
          });
          const translatedSlugRaw = await textService.complete(slugPrompt, { temperature: 0.1 });
          const translatedSlug = cleanAITextOutput(translatedSlugRaw);
          let normalized = normalizeSlug(translatedSlug);
          if (!normalized) {
            normalized = normalizeSlug(segmentSources.slug);
            localeNotices.push('Slug translation was empty; reused normalized source slug.');
          } else if (normalized !== translatedSlug) {
            localeNotices.push('Slug was normalized to meet URL constraints.');
          }
          if (!normalized) {
            throw new Error('Unable to produce a valid slug.');
          }
          localeResult.slug = normalized;
        }

        if (segmentSources.title) {
          const titlePrompt = await buildTranslatePrompt(locale, {
            contentType: 'title',
            originalText: segmentSources.title,
            ...(payload.storyTitle && { storyTitle: payload.storyTitle }),
            sourceLocale: payload.sourceLocale,
            extraContext,
          });
          const translatedTitle = cleanAITextOutput(
            await textService.complete(titlePrompt, { temperature: 0.2 }),
          );
          localeResult.title = translatedTitle;
        }

        if (segmentSources.summary) {
          const summaryPrompt = await buildTranslatePrompt(locale, {
            contentType: 'text',
            originalText: segmentSources.summary,
            ...(payload.storyTitle && { storyTitle: payload.storyTitle }),
            sourceLocale: payload.sourceLocale,
            extraContext,
          });
          const translatedSummary = cleanAITextOutput(
            await textService.complete(summaryPrompt, { temperature: 0.2 }),
          );
          localeResult.summary = translatedSummary;
        }

        if (segmentSources.content) {
          const contentPrompt = await buildTranslatePrompt(locale, {
            contentType,
            originalText: segmentSources.content,
            ...(payload.storyTitle && { storyTitle: payload.storyTitle }),
            sourceLocale: payload.sourceLocale,
            extraContext,
          });
          const translatedContent = cleanAITextOutput(
            await textService.complete(contentPrompt, { temperature: 0.2 }),
          );
          localeResult.content = translatedContent;
          localeResult.contentFormat = contentFormat;
        }

        translations[locale] = localeResult;
        if (localeNotices.length > 0) {
          notices[locale] = localeNotices;
        }
      } catch (localeError) {
        const message = localeError instanceof Error ? localeError.message : String(localeError);
        logger.error('Translation failed for locale', {
          locale,
          sourceLocale: payload.sourceLocale,
          requestId,
          error: message,
        });
        res.status(500).json({
          success: false,
          requestId,
          error: `Translation failed for ${locale}: ${message}`,
        });
        return;
      }
    }

    res.json({
      success: true,
      requestId,
      sourceLocale: payload.sourceLocale,
      translations,
      notices,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid translation request',
        issues: error.issues,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Translation failed',
    });
  }
});

// Endpoint to clear context explicitly (used at workflow completion)
router.post('/text/context/clear', async (req, res) => {
  try {
    const Schema = z.object({ storyId: z.string().uuid(), runId: z.string().uuid() });
    const { storyId, runId } = Schema.parse(req.body);
    const contextId = `${storyId}:${runId}`;
    const { contextManager } = await import('@/ai/context-manager.js');
    await contextManager.clearContext(contextId);
    // Provider-specific cleanup (google genai)
    const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
    if (textProvider === 'google-genai') {
      try {
        const service: any = aiGateway.getTextService({
          authorId: 'n/a',
          storyId,
          action: 'story_outline',
        });
        if (typeof service.clearContext === 'function') {
          await service.clearContext(contextId);
        }
      } catch (provErr) {
        logger.warn('Provider clearContext failed', {
          contextId,
          error: provErr instanceof Error ? provErr.message : String(provErr),
        });
      }
    }
    res.json({ success: true, contextId });
  } catch (error) {
    res
      .status(400)
      .json({ success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
});

/**
 * POST /ai/image
 * Generate an image using AI image generation and store it in Google Cloud Storage
 * Includes safety block handling with automatic prompt rewriting
 */
router.post('/image', async (req, res) => {
  let currentStep = 'parsing_request';
  let promptRewriteAttempted = false;
  let originalPrompt: string | undefined;
  let fallbackPromptUsed = false;

  try {
    const { prompt, storyId, runId, chapterNumber, imageType, width, height, style } =
      validateImageRequest(req.body);

    originalPrompt = prompt;

    // Get story context to extract authorId for token tracking
    const storyContext = await storyService.getStoryContext(storyId);
    if (!storyContext) {
      res.status(404).json({
        success: false,
        error: 'Story not found',
      });
      return;
    }

    // Create context for token tracking
    const imageContext = {
      authorId: storyContext.story.authorId,
      storyId: storyId,
      action: 'image_generation' as const,
    };

    // Set default dimensions using environment configuration
    let imageWidth = width;
    let imageHeight = height;

    if (!imageWidth && !imageHeight) {
      const dimensions = getImageDimensions(imageType);
      imageWidth = dimensions.width;
      imageHeight = dimensions.height;
    }

    // Assemble up to four reference images (JPEG only), prioritizing character photo references,
    // then falling back to existing cover/previous-chapter references when capacity remains.
    currentStep = 'collecting_references';
    const referenceImages: Array<{ buffer: Buffer; mimeType: string; source: string }> = [];
    const seenReferenceFiles = new Set<string>();
    const MAX_REFERENCE_IMAGES = 4;
    try {
      const storyRecord = await storyService.getStory(storyId); // includes cover/backcover URIs
      const storage = getStorageService();
      const bucketName = process.env.STORAGE_BUCKET_NAME;

      const isSupportedGcsUrl = (url: string): boolean => {
        if (!bucketName) return false;
        if (url.startsWith(`gs://${bucketName}/`)) return true;
        try {
          const parsed = new URL(url);
          return (
            parsed.hostname === 'storage.googleapis.com' &&
            parsed.pathname.startsWith(`/${bucketName}/`)
          );
        } catch {
          return false;
        }
      };

      const addRef = async (uri: string | null | undefined, source: string) => {
        if (!uri) return;
        if (referenceImages.length >= MAX_REFERENCE_IMAGES) return;
        if (!isSupportedGcsUrl(uri)) {
          logger.debug('Skipping non-bucket reference image', { uri, source });
          return;
        }
        const filename = extractFilenameFromUri(uri);
        if (!filename || seenReferenceFiles.has(filename)) return;
        const lower = filename.toLowerCase();
        if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg')) {
          logger.debug('Skipping non-jpeg reference image', { filename, source });
          return;
        }
        try {
          const buf = await storage.downloadFileAsBuffer(filename);
          referenceImages.push({ buffer: buf, mimeType: 'image/jpeg', source });
          seenReferenceFiles.add(filename);
          logger.info('Reference image added', { source, size: buf.length, filename });
        } catch (refErr) {
          logger.warn('Failed to load reference image', {
            source,
            error: refErr instanceof Error ? refErr.message : String(refErr),
          });
        }
      };

      // First preference: character photo references tied to the scene
      try {
        const outlineStep = await runsService.getStepResult(runId, 'generate_outline');
        const parsedOutline = outlineStep?.detailJson
          ? OutlineSchema.safeParse(outlineStep.detailJson)
          : null;

        if (parsedOutline?.success && imageType) {
          const outline = parsedOutline.data;
          const sceneNames: string[] = (() => {
            if (imageType === 'front_cover') return outline.bookCoverCharacters || [];
            if (imageType === 'back_cover') return outline.bookBackCoverCharacters || [];
            if (imageType === 'chapter' && typeof chapterNumber === 'number') {
              const match = outline.chapters.find((c) => c.chapterNumber === chapterNumber);
              return match?.charactersInScene || [];
            }
            return [];
          })();

          const uniqueNames = Array.from(
            new Set(
              sceneNames.filter(
                (name): name is string =>
                  typeof name === 'string' && name.trim().length > 0,
              ),
            ),
          );
          const nameToCharacter = new Map(
            outline.characters.map((c) => [c.name, c] as const),
          );
          const storyNameToId = new Map(
            storyContext.characters
              .filter((c) => typeof c.characterId === 'string' && c.characterId.length > 0)
              .map((c) => [c.name, c.characterId as string] as const),
          );
          const candidateIds = uniqueNames
            .map((name) => nameToCharacter.get(name)?.characterId || storyNameToId.get(name))
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const uniqueIds = Array.from(new Set(candidateIds));

          if (uniqueIds.length > 0) {
            const charactersWithPhotos = await characterService.getCharactersByIds(uniqueIds);
            for (const character of charactersWithPhotos) {
              if (!character.photoUrl || !isSupportedGcsUrl(character.photoUrl)) continue;
              await addRef(character.photoUrl, `character:${character.characterId}`);
              if (referenceImages.length >= MAX_REFERENCE_IMAGES) break;
            }
          }
        }
      } catch (charRefErr) {
        logger.warn('Character reference collection failed', {
          storyId,
          runId,
          imageType,
          error: charRefErr instanceof Error ? charRefErr.message : String(charRefErr),
        });
      }

      // Secondary preference: existing cover/back/previous chapter references
      if (storyRecord) {
        if (imageType === 'back_cover') {
          await addRef(storyRecord.coverUri as string | undefined, 'cover');
        } else if (imageType === 'chapter') {
          // Front cover first
          await addRef(storyRecord.coverUri as string | undefined, 'cover');
          // Previous chapter image
          if (typeof chapterNumber === 'number' && chapterNumber > 1) {
            try {
              // Query latest version of previous chapter
              const db = (await import('@/db/connection.js')).getDatabase();
              const { chapters } = await import('@/db/schema/index.js');
              const { and, eq, desc } = await import('drizzle-orm');
              const prev = await db
                .select({ imageUri: chapters.imageUri, version: chapters.version })
                .from(chapters)
                .where(
                  and(eq(chapters.storyId, storyId), eq(chapters.chapterNumber, chapterNumber - 1)),
                )
                .orderBy(desc(chapters.version))
                .limit(1);
              const prevUri = prev[0]?.imageUri as string | undefined;
              await addRef(prevUri, `chapter_${chapterNumber - 1}`);
            } catch (dbErr) {
              logger.warn('Failed to fetch previous chapter image for reference', {
                storyId,
                chapterNumber,
                error: dbErr instanceof Error ? dbErr.message : String(dbErr),
              });
            }
          }
        }
      }
    } catch (refCollectErr) {
      logger.warn('Reference image collection failed', {
        error: refCollectErr instanceof Error ? refCollectErr.message : String(refCollectErr),
      });
    }

    // Log summary
    logger.info('Reference images summary', {
      count: referenceImages.length,
      sources: referenceImages.map((r) => r.source),
      totalSizeBytes: referenceImages.reduce((acc, r) => acc + r.buffer.length, 0),
    });

    // Helper function to attempt image generation
    const attemptImageGeneration = async (promptToUse: string): Promise<Buffer> => {
      return await aiGateway.getImageService(imageContext).generate(promptToUse, {
        ...(imageWidth && { width: imageWidth }),
        ...(imageHeight && { height: imageHeight }),
        ...(style && { style }),
        bookTitle: storyContext.story.title,
        ...(storyContext.story.graphicalStyle && {
          graphicalStyle: storyContext.story.graphicalStyle,
        }),
        ...(imageType && { imageType }),
        ...(referenceImages.length > 0 && { referenceImages }),
      });
    };

    // Try image generation with safety block handling
    currentStep = 'generating_image';
    let imageBuffer: Buffer;
    let finalPrompt = prompt;

    try {
      // First attempt with original prompt
      imageBuffer = await attemptImageGeneration(prompt);
    } catch (firstError) {
      // Check if this is a safety block error
      const { isSafetyBlockError } = await import('@/shared/retry-utils.js');

      if (isSafetyBlockError(firstError)) {
        logger.warn('Image generation blocked by safety system, attempting prompt rewrite', {
          storyId,
          runId,
          imageType,
          chapterNumber,
          originalPromptLength: prompt.length,
          error: firstError instanceof Error ? firstError.message : String(firstError),
        });

        currentStep = 'rewriting_prompt';
        promptRewriteAttempted = true;

        try {
          // Load the safety rewrite prompt template
          const rewritePromptTemplate = await PromptService.loadPrompt(
            'en-US',
            'image-prompt-safety-rewrite',
          );

          // Prepare template variables
          const rewriteVars = {
            safetyError: firstError instanceof Error ? firstError.message : String(firstError),
            imageType: imageType || 'chapter',
            bookTitle: storyContext.story.title,
            graphicalStyle: storyContext.story.graphicalStyle || 'illustration',
            chapterNumber: chapterNumber?.toString() || '',
            originalPrompt: prompt,
          };

          // Build the rewrite prompt
          const rewritePrompt = PromptService.buildPrompt(rewritePromptTemplate, rewriteVars);

          // Use GenAI (Google) to rewrite the prompt - force TEXT_PROVIDER temporarily
          const originalProvider = process.env.TEXT_PROVIDER;
          process.env.TEXT_PROVIDER = 'google-genai';

          try {
            // Create a text context for the rewrite
            const textContext = {
              authorId: storyContext.story.authorId,
              storyId: storyId,
              action: 'prompt_rewrite' as const,
            };

            // Get the rewritten prompt from GenAI
            const rewrittenPrompt = await aiGateway
              .getTextService(textContext)
              .complete(rewritePrompt, {
                temperature: 0.7, // Moderate creativity for rewriting
                maxTokens: 65535,
              });

            // Restore original provider
            if (originalProvider) {
              process.env.TEXT_PROVIDER = originalProvider;
            }

            // Clean up the rewritten prompt
            finalPrompt = rewrittenPrompt.trim();

            // Check if GenAI refused to rewrite
            if (finalPrompt.startsWith('UNABLE_TO_REWRITE:')) {
              throw new Error(
                'GenAI determined the prompt is fundamentally unsafe and cannot be rewritten',
              );
            }

            logger.info('Prompt successfully rewritten by GenAI', {
              storyId,
              runId,
              imageType,
              originalLength: prompt.length,
              rewrittenLength: finalPrompt.length,
              rewrittenPrompt: finalPrompt.substring(0, 100) + '...',
            });

            // Retry image generation with rewritten prompt (one attempt only)
            currentStep = 'generating_image_with_rewritten_prompt';
            imageBuffer = await attemptImageGeneration(finalPrompt);

            logger.info('Image generation succeeded with rewritten prompt', {
              storyId,
              runId,
              imageType,
              chapterNumber,
            });
          } finally {
            // Restore original provider in case of error
            if (originalProvider) {
              process.env.TEXT_PROVIDER = originalProvider;
            }
          }
        } catch (rewriteError) {
          logger.error('Prompt rewrite or retry failed', {
            storyId,
            runId,
            imageType,
            chapterNumber,
            error: rewriteError instanceof Error ? rewriteError.message : String(rewriteError),
          });

          const fallbackPrompt = storyContext.story.graphicalStyle
            ? buildSafeFallbackPrompt(prompt, { styleHint: storyContext.story.graphicalStyle })
            : buildSafeFallbackPrompt(prompt);

          try {
            fallbackPromptUsed = true;
            finalPrompt = fallbackPrompt;
            currentStep = 'generating_image_with_fallback_prompt';
            imageBuffer = await attemptImageGeneration(finalPrompt);
            logger.info('Image generation succeeded with fallback sanitized prompt', {
              storyId,
              runId,
              imageType,
              chapterNumber,
            });
          } catch (fallbackErr) {
            const enrichedError: any = firstError;
            enrichedError.promptRewriteAttempted = true;
            enrichedError.promptRewriteError =
              rewriteError instanceof Error ? rewriteError.message : String(rewriteError);
            enrichedError.fallbackAttempted = true;
            enrichedError.fallbackError =
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            throw enrichedError;
          }
        }
      } else {
        // Not a safety block, re-throw as-is
        throw firstError;
      }
    }

    currentStep = 'preparing_upload';
    const filename = generateImageFilename({
      storyId,
      ...(imageType ? { imageType } : {}),
      ...(chapterNumber !== undefined ? { chapterNumber } : {}),
    });
    currentStep = 'uploading_to_storage';
    const imageUrl = await storageService.uploadFile(filename, imageBuffer, 'image/jpeg');

    res.json({
      success: true,
      storyId,
      runId,
      chapterNumber,
      image: {
        url: imageUrl,
        filename,
        format: 'jpeg',
        size: imageBuffer.length,
        referenceImageCount: referenceImages.length,
        referenceImageSources: referenceImages.map((r) => r.source),
      },
      ...(promptRewriteAttempted && {
        promptRewriteApplied: true,
        originalPrompt: originalPrompt,
        rewrittenPrompt: finalPrompt,
        ...(fallbackPromptUsed && { promptRewriteFallback: true }),
      }),
    });
  } catch (error) {
    const errorDetails = formatImageError(error, req.body, currentStep);

    // Check if it's a safety block to return 422 instead of 500
    const { isSafetyBlockError } = await import('@/shared/retry-utils.js');
    const isSafetyBlock = isSafetyBlockError(error);

    const statusCode = isSafetyBlock ? 422 : 500;
    const resp: any = {
      success: false,
      error: errorDetails.message,
      failedAt: currentStep,
      timestamp: errorDetails.timestamp,
      requestId: req.body.runId || 'unknown',
    };
    if (errorDetails.code) resp.code = errorDetails.code;
    if (errorDetails.category) resp.category = errorDetails.category;
    if (errorDetails.provider) resp.provider = errorDetails.provider;
    if (errorDetails.providerFinishReasons)
      resp.providerFinishReasons = errorDetails.providerFinishReasons;
    if (errorDetails.suggestions) resp.suggestions = errorDetails.suggestions;
    if (promptRewriteAttempted) resp.promptRewriteAttempted = true;
    if ((error as any)?.promptRewriteError)
      resp.promptRewriteError = (error as any).promptRewriteError;
    if ((error as any)?.fallbackAttempted) resp.fallbackAttempted = true;
    if ((error as any)?.fallbackError) resp.fallbackError = (error as any).fallbackError;
    if (fallbackPromptUsed) resp.fallbackPromptUsed = true;
    res.status(statusCode).json(resp);
  }
});

/**
 * GET /ai/test-text
 * Test the configured text AI provider with environment variables and basic prompt
 */
router.get('/test-text', async (_req, res) => {
  try {
    // Collect relevant environment variables for AI provider selection
    const envVars = {
      TEXT_PROVIDER: process.env.TEXT_PROVIDER,
      IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,

      // Google GenAI
      GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY ? '***REDACTED***' : undefined,
      GOOGLE_GENAI_MODEL: process.env.GOOGLE_GENAI_MODEL,
      GOOGLE_GENAI_IMAGE_MODEL: process.env.GOOGLE_GENAI_IMAGE_MODEL,

      // OpenAI
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***REDACTED***' : undefined,
      OPENAI_TEXT_MODEL: process.env.OPENAI_TEXT_MODEL,
      OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,

      // Debug settings
      DEBUG_AI_FULL_PROMPTS: process.env.DEBUG_AI_FULL_PROMPTS,
      DEBUG_AI_FULL_RESPONSES: process.env.DEBUG_AI_FULL_RESPONSES,
      LOG_LEVEL: process.env.LOG_LEVEL,
    };

    // Create a test context for the AI call
    const testContext = {
      authorId: '00000000-0000-0000-0000-000000000001', // Test UUID
      storyId: '00000000-0000-0000-0000-000000000002', // Test UUID
      action: 'test' as const,
    };

    let success = false;
    let response = '';
    let error = null;
    let provider = '';

    try {
      // Get the text service from the AI gateway
      const textService = aiGateway.getTextService(testContext);
      provider = process.env.TEXT_PROVIDER || 'google-genai';

      // Make a basic prompt request
      response = await textService.complete(
        'Say hi and tell me you are working correctly. Keep it brief.',
        {
          temperature: 0.7,
        },
      );

      success = true;
    } catch (aiError) {
      success = false;
      error = {
        message: aiError instanceof Error ? aiError.message : String(aiError),
        stack: aiError instanceof Error ? aiError.stack : undefined,
        name: aiError instanceof Error ? aiError.name : 'UnknownError',
      };
    }

    res.json({
      success,
      timestamp: new Date().toISOString(),
      environment: envVars,
      testResult: {
        provider,
        response: success ? response : null,
        error: error,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : 'UnknownError',
      },
    });
  }
});

export { router as aiRouter };
