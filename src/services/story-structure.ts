/**
 * Story Structure Service
 *
 * Turns author input (text, audio, and extracted image metadata) into a
 * structured story foundation: persists story fields, creates/links characters,
 * crops character photos from source input images, and records which input
 * photos are relevant for cover generation.
 *
 * IMPORTANT: image *bytes* are never sent to the structure model. Only the
 * previously-extracted metadata (description / OCR / detected characters) is
 * passed as text. Audio (when present) is still passed as a multimodal part.
 *
 * Shared by the legacy synchronous route (`POST /ai/text/structure`) and the
 * async job worker (`POST /jobs/story-structure`).
 */

import { eq } from 'drizzle-orm';
import { StoryService } from '@/services/story.js';
import { CharacterService } from '@/services/characters.js';
import { PromptService } from '@/services/prompt.js';
import { SchemaService } from '@/services/schema.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { parseAIResponse } from '@/shared/utils.js';
import { logger } from '@/config/logger.js';
import {
  loadOrAnalyzeMetadata,
  metadataPathFor,
  type ImageMetadata,
} from '@/services/image-analysis.js';
import { cropToJpeg } from '@/utils/imageProcessing.js';
import { randomUUID } from 'crypto';

const aiGateway = getAIGatewayWithTokenTracking();
const storyService = new StoryService();
const characterService = new CharacterService();

// Accept only real (v1-v5) UUIDs; models sometimes emit placeholders like "character_1"
const UUID_RE =
  /^(?!00000000-0000-0000-0000-000000000000)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

// The `story_language` column is varchar(5), sized for BCP-47 locale codes
// (e.g. `en-US`). Models sometimes return a language *name* ("English") instead,
// which overflows the column and aborts the whole UPDATE. Normalise to a code,
// falling back to the request locale (already a valid code) when unresolved.
const LANGUAGE_NAME_TO_LOCALE: Record<string, string> = {
  english: 'en-US',
  portuguese: 'pt-PT',
  'portuguese (portugal)': 'pt-PT',
  'portuguese (brazil)': 'pt-BR',
  spanish: 'es-ES',
  french: 'fr-FR',
  german: 'de-DE',
  italian: 'it-IT',
  chinese: 'zh-CN',
};

function toStoryLanguageCode(value: unknown, fallback: string): string {
  const fb = (fallback || 'en-US').slice(0, 5);
  if (typeof value !== 'string' || !value.trim()) return fb;
  const v = value.trim();
  // Already a locale/language code such as `en` or `en-US`.
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(v) && v.length <= 5) {
    const parts = v.split('-');
    const lang = (parts[0] ?? v).toLowerCase();
    const region = parts[1];
    return region ? `${lang}-${region.toUpperCase()}` : lang;
  }
  return LANGUAGE_NAME_TO_LOCALE[v.toLowerCase()]?.slice(0, 5) ?? fb;
}

export interface GenerateStoryStructureParams {
  storyId: string;
  userDescription?: string;
  imageObjectPaths?: string[];
  audioObjectPath?: string;
  characterIds?: string[];
  /** Locale used when an image still needs to be analysed on demand. */
  locale?: string;
}

export interface StoryStructureResult {
  storyId: string;
  story: Record<string, unknown>;
  characters: unknown[];
  originalInput: string;
}

export class StructureError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'StructureError';
    this.statusCode = statusCode;
  }
}

type ImageMetaWithPath = ImageMetadata & { path: string };

/**
 * Crop the detected person/animal out of its source photo and store it as the
 * character's photo (same convention as `POST /ai/media/character-photo`).
 * Returns the public URL, or null when cropping is not possible.
 */
async function cropCharacterPhoto(
  authorId: string,
  characterId: string,
  sourceImagePath: string,
  index: number,
  imageMetas: ImageMetaWithPath[],
): Promise<string | null> {
  const meta = imageMetas.find((m) => m.path === sourceImagePath);
  if (!meta || meta.overallImageContent !== 'photo') return null;

  const detected = meta.characters[index];
  if (!detected || !Array.isArray(detected.box_2d) || detected.box_2d.length !== 4) return null;

  const storage = getStorageService();
  const original = await storage.downloadFileAsBuffer(sourceImagePath);
  const cropped = await cropToJpeg(original, detected.box_2d);

  const version = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const objectPath = `${authorId}/characters/${characterId}/${version}.jpg`;
  const publicUrl = await storage.uploadFile(objectPath, cropped, 'image/jpeg', {
    cacheControl: 'public, max-age=31536000',
  });
  await characterService.updateCharacterPhoto(characterId, objectPath, objectPath);

  logger.info('Cropped character photo from input image', {
    characterId,
    sourceImagePath,
    index,
  });
  return publicUrl;
}

/** Map a staged input path to its story-scoped equivalent (keeps the filename). */
function storyInputPath(storyId: string, objectPath: string): string {
  const file = objectPath.slice(objectPath.lastIndexOf('/') + 1);
  return `${storyId}/inputs/${file}`;
}

/**
 * Bring staged inputs (image + sibling `.json` metadata + audio) into
 * `{storyId}/inputs/`, so the story owns a durable, self-contained copy of
 * everything that fed the outline.
 *
 * - Sources under the author's staging folder (`{authorId}/inputs/`) are MOVED
 *   (single-use staging, deleted after).
 * - Sources already under another `{storyId}/inputs/` folder — which happens
 *   when the user navigates back to Step 2 and re-submits inputs that a prior
 *   generation already relocated — are COPIED, so the earlier story keeps its
 *   own snapshot intact.
 *
 * Resilient to job retries: a missing source whose destination already exists is
 * treated as already-relocated. Returns the remapped story-scoped paths.
 */
async function relocateInputsToStory(
  storyId: string,
  authorId: string,
  imagePaths: string[],
  audioPath?: string,
): Promise<{ imageObjectPaths: string[]; audioObjectPath?: string | undefined }> {
  const storage = getStorageService();
  const stagingPrefix = `${authorId}/inputs/`;

  const relocate = async (src: string): Promise<string> => {
    const dest = storyInputPath(storyId, src);
    if (dest === src) return dest;
    try {
      if (await storage.fileExists(src)) {
        // Move out of staging; copy when the source is another story's input.
        if (src.startsWith(stagingPrefix)) {
          await storage.moveFile(src, dest);
        } else {
          await storage.copyFile(src, dest);
        }
      } else if (!(await storage.fileExists(dest))) {
        logger.warn('Input to relocate not found at source or destination', { src, dest });
      }
    } catch (e) {
      logger.warn('Failed to relocate input into story folder', {
        src,
        dest,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return dest;
  };

  const imageObjectPaths: string[] = [];
  for (const src of imagePaths) {
    imageObjectPaths.push(await relocate(src));
    // Move the sibling metadata JSON too, when it exists.
    const srcJson = metadataPathFor(src);
    if (await storage.fileExists(srcJson)) {
      await relocate(srcJson);
    }
  }

  const audioObjectPath = audioPath ? await relocate(audioPath) : undefined;
  return { imageObjectPaths, audioObjectPath };
}

/**
 * Persist a durable, self-contained input snapshot under `{storyId}/inputs/`:
 * the user's text as `description.txt` and a `manifest.json` tying together the
 * text, image paths + metadata, audio and generation parameters. This is what a
 * future "re-generate outline" feature replays. Best-effort: never fails the job.
 */
async function writeInputSnapshot(args: {
  storyId: string;
  locale: string;
  userDescription: string;
  characterIds: string[];
  imageMetas: ImageMetaWithPath[];
  audioObjectPath?: string | undefined;
}): Promise<void> {
  const storage = getStorageService();
  const base = `${args.storyId}/inputs`;
  try {
    if (args.userDescription) {
      await storage.uploadFile(
        `${base}/description.txt`,
        Buffer.from(args.userDescription, 'utf8'),
        'text/plain; charset=utf-8',
      );
    }

    const manifest = {
      storyId: args.storyId,
      locale: args.locale,
      createdAt: new Date().toISOString(),
      textFile: args.userDescription ? 'description.txt' : null,
      userDescription: args.userDescription,
      characterIds: args.characterIds,
      audio: args.audioObjectPath ?? null,
      images: args.imageMetas.map((m) => ({
        path: m.path,
        metadataPath: metadataPathFor(m.path),
        overallImageContent: m.overallImageContent,
      })),
    };
    await storage.uploadFile(
      `${base}/manifest.json`,
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      'application/json',
    );

    logger.info('Wrote story input snapshot', {
      storyId: args.storyId,
      images: manifest.images.length,
      hasAudio: !!manifest.audio,
      hasText: !!args.userDescription,
    });
  } catch (e) {
    logger.warn('Failed to write story input snapshot', {
      storyId: args.storyId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function generateStoryStructure(
  params: GenerateStoryStructureParams,
): Promise<StoryStructureResult> {
  const { storyId, userDescription, characterIds } = params;
  const analysisLocale = params.locale || 'en-US';

  const storyContext = await storyService.getStoryContext(storyId);
  if (!storyContext) {
    throw new StructureError('Story not found', 404);
  }
  const authorId = storyContext.story.authorId;

  // Relocate staged inputs (uploaded author-scoped in step 2, before the story
  // existed) into this story's own `{storyId}/inputs/` folder. All downstream
  // work — metadata, cropping, cover references — then uses the story-scoped
  // paths, so the story owns a self-contained copy of its inputs.
  const { imageObjectPaths, audioObjectPath } = await relocateInputsToStory(
    storyId,
    authorId,
    params.imageObjectPaths ?? [],
    params.audioObjectPath,
  );

  // Load and author-verify any explicitly requested characters
  let existingCharacters: Array<Record<string, any>> = [];
  if (characterIds && characterIds.length > 0) {
    const requested = await characterService.getCharactersByIds(characterIds);
    existingCharacters = requested.filter((c) => c.authorId === authorId);
    if (existingCharacters.length !== characterIds.length) {
      logger.warn("Some requested characters don't belong to the author", {
        requestedCount: characterIds.length,
        validCount: existingCharacters.length,
        authorId,
      });
    }
  }

  // Gather per-image metadata (reusing persisted .json, analysing on demand).
  const storage = getStorageService();
  const imageMetas: ImageMetaWithPath[] = [];
  for (const path of imageObjectPaths) {
    const meta = await loadOrAnalyzeMetadata(path, analysisLocale, { authorId });
    if (meta) imageMetas.push({ path, ...meta });
  }

  // Metadata payload for the prompt — pixel boxes omitted, indexes kept for mapping.
  const promptImageMetadata = imageMetas.map((m) => ({
    path: m.path,
    overallImageContent: m.overallImageContent,
    description: m.description,
    text: m.text,
    characters: m.characters.map((c, index) => ({
      index,
      type: c.type,
      age: c.age,
      physicalDescription: c.physicalDescription,
    })),
  }));

  // Build prompt + schema
  const promptTemplate = await PromptService.loadPrompt('en-US', 'text-structure');
  const defaultPersona = 'classic-novelist';
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
    imageMetadata: JSON.stringify(promptImageMetadata),
    literaryPersona: defaultPersona,
  };
  const structSchema = await SchemaService.loadSchema('story-structure');

  const aiContext = {
    authorId,
    storyId,
    action: 'story_structure' as const,
  };

  // Audio is the only multimodal part now (images are passed as metadata text).
  const mediaParts: Array<{ mimeType: string; data: Buffer }> = [];
  if (audioObjectPath) {
    try {
      const meta = await storage
        .getFileMetadata(audioObjectPath)
        .catch(() => ({ contentType: 'audio/wav' as string | undefined }));
      const buf = await storage.downloadFileAsBuffer(audioObjectPath);
      mediaParts.push({ mimeType: meta.contentType || 'audio/wav', data: buf });
    } catch (e) {
      logger.warn('Failed to load audio for structure generation', {
        audioObjectPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const textProvider = process.env.TEXT_PROVIDER || 'google-genai';
  let aiResponse: string;
  if (textProvider === 'google-genai') {
    const { systemInstruction, userPrompt } = PromptService.buildParts(
      promptTemplate,
      templateVars,
    );
    const structureModel = process.env.GOOGLE_GENAI_MODEL || 'gemini-3.5-flash';
    aiResponse = await aiGateway.getTextService(aiContext).complete(userPrompt, {
      temperature: 1,
      model: structureModel,
      jsonSchema: structSchema,
      ...(mediaParts.length ? { mediaParts } : {}),
      thinkingLevel: 'high',
      systemInstruction,
    });
  } else {
    const finalPrompt = PromptService.buildPrompt(promptTemplate, templateVars);
    const model = process.env.OPENAI_BASE_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-5.5';
    aiResponse = await aiGateway.getTextService(aiContext).complete(finalPrompt, {
      temperature: 0.8,
      model,
      jsonSchema: structSchema,
    });
  }

  const parsed = parseAIResponse(aiResponse) as any;
  if (!parsed || typeof parsed !== 'object' || !parsed.story || !Array.isArray(parsed.characters)) {
    logger.error('Invalid structure response', {
      receivedKeys: parsed ? Object.keys(parsed) : null,
    });
    throw new StructureError('Invalid structured response from AI', 500);
  }

  // Persist story fields (subset used by the app)
  const updates: Record<string, unknown> = {};
  if (parsed.story.title) updates.title = parsed.story.title;
  if (parsed.story.plotDescription) updates.plotDescription = parsed.story.plotDescription;
  if (parsed.story.synopsis) updates.synopsis = parsed.story.synopsis;
  if (parsed.story.place) updates.place = parsed.story.place;
  if (parsed.story.additionalRequests) updates.additionalRequests = parsed.story.additionalRequests;
  if (parsed.story.targetAudience) updates.targetAudience = parsed.story.targetAudience;
  if (parsed.story.novelStyle) updates.novelStyle = parsed.story.novelStyle;
  if (parsed.story.graphicalStyle) updates.graphicalStyle = parsed.story.graphicalStyle;
  updates.literaryPersona = defaultPersona;
  updates.storyLanguage = toStoryLanguageCode(parsed.story.storyLanguage, analysisLocale);

  // Cover reference URIs: only photo-type inputs that were actually provided.
  const bucket = process.env.STORAGE_BUCKET_NAME;
  const providedPaths = new Set(imageObjectPaths);
  const photoPaths = new Set(
    imageMetas.filter((m) => m.overallImageContent === 'photo').map((m) => m.path),
  );
  const toUri = (p: string) => (bucket ? `https://storage.googleapis.com/${bucket}/${p}` : p);
  const flaggedPaths = [
    ...(Array.isArray(parsed.story.coverReferenceImages) ? parsed.story.coverReferenceImages : []),
    ...(Array.isArray(parsed.story.backCoverReferenceImages)
      ? parsed.story.backCoverReferenceImages
      : []),
  ].filter(
    (p: unknown): p is string => typeof p === 'string' && providedPaths.has(p) && photoPaths.has(p),
  );
  const coverReferenceUris = Array.from(new Set(flaggedPaths)).map(toUri);
  updates.coverReferenceUris = coverReferenceUris.length ? coverReferenceUris : null;

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

  // Fallback character->photo mapping. Models often forget to set
  // `sourceImagePath`/`sourceCharacterIndex`, which silently skips cropping.
  // When the model linked nobody but there is exactly one photo with detected
  // people, map detected people to characters in order so crops still happen.
  const photoMetasWithPeople = imageMetas.filter(
    (m) => m.overallImageContent === 'photo' && m.characters.length > 0,
  );
  const modelLinkedAnyCharacter = (parsed.characters as any[]).some(
    (c) => typeof c.sourceImagePath === 'string' && Number.isInteger(c.sourceCharacterIndex),
  );
  const singlePhotoMeta =
    !modelLinkedAnyCharacter && photoMetasWithPeople.length === 1
      ? photoMetasWithPeople[0]
      : undefined;
  const fallbackPairs: Array<{ path: string; index: number }> = singlePhotoMeta
    ? singlePhotoMeta.characters.map((_, index) => ({ path: singlePhotoMeta.path, index }))
    : [];
  let fallbackCursor = 0;

  // Create/reuse characters, crop photos from source images, link to story
  const processedCharacters: Array<Record<string, any>> = [];
  for (const ch of parsed.characters as any[]) {
    let record: Record<string, any> | null = null;

    if (typeof ch.characterId === 'string' && UUID_RE.test(ch.characterId)) {
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
      record =
        (await characterService.createCharacter({
          name: ch.name,
          authorId,
          type: ch.type,
          age: ch.age,
          traits: Array.isArray(ch.traits) ? ch.traits : undefined,
          characteristics: ch.characteristics,
          physicalDescription: ch.physicalDescription,
        })) ?? null;
    }

    if (!record) continue;

    // Resolve which detected person to crop: prefer the model's explicit link,
    // otherwise consume the next heuristic fallback pair (single-photo case).
    let cropPath: string | null =
      typeof ch.sourceImagePath === 'string' ? ch.sourceImagePath : null;
    let cropIndex: number | null = Number.isInteger(ch.sourceCharacterIndex)
      ? ch.sourceCharacterIndex
      : null;
    let usedFallback = false;
    const fallbackPair = fallbackPairs[fallbackCursor];
    if ((cropPath === null || cropIndex === null) && fallbackPair) {
      cropPath = fallbackPair.path;
      cropIndex = fallbackPair.index;
      fallbackCursor++;
      usedFallback = true;
    }

    // Crop a character photo from the source input image when available
    if (!record.photoUrl && cropPath && cropIndex !== null) {
      try {
        const url = await cropCharacterPhoto(
          authorId,
          record.characterId,
          cropPath,
          cropIndex,
          imageMetas,
        );
        if (url) {
          record.photoUrl = url;
          if (usedFallback) {
            logger.info('Cropped character photo via heuristic fallback mapping', {
              characterId: record.characterId,
              sourceImagePath: cropPath,
              index: cropIndex,
            });
          }
        }
      } catch (e) {
        logger.warn('Character photo crop failed', {
          characterId: record.characterId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

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

  // Persist the durable input snapshot (text + manifest) alongside the inputs
  // we already relocated, so the story can be re-generated from its own folder.
  await writeInputSnapshot({
    storyId,
    locale: analysisLocale,
    userDescription: userDescription ?? '',
    characterIds: characterIds ?? [],
    imageMetas,
    audioObjectPath,
  });

  return {
    storyId,
    story: { ...updates, storyId },
    characters: processedCharacters,
    originalInput: userDescription ?? '',
  };
}
