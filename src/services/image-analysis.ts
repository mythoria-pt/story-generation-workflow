/**
 * Image Analysis Service
 *
 * Extracts structured metadata (type, description, OCR text, detected characters
 * with bounding boxes) from a user-uploaded input image using a multimodal
 * vision-language model. Metadata is persisted alongside the image in GCS as a
 * sibling `.json` file so it can be reused without re-analysing.
 *
 * Provider is chosen via IMAGE_ANALYZER_PROVIDER -> IMAGE_PROVIDER -> google-genai.
 */

import { getStorageService } from '@/services/storage-singleton.js';
import { getAIGatewayWithTokenTracking } from '@/ai/gateway-with-tracking.js';
import { PromptService } from '@/services/prompt.js';
import { SchemaService } from '@/services/schema.js';
import { getLanguageName, parseAIResponse } from '@/shared/utils.js';
import { logger } from '@/config/logger.js';
import { z } from 'zod';
import type { Box2d } from '@/utils/imageProcessing.js';

const aiGateway = getAIGatewayWithTokenTracking();
type ImageAnalysisOptions = {
  requestId?: string;
  assetId?: string;
  authorId?: string;
  storage?: ReturnType<typeof getStorageService>;
  privateContent?: boolean;
  createOnly?: boolean;
  accessPrivateInput?: <T>(action: () => Promise<T>) => Promise<T | undefined>;
};

export type ImageAnalysisCode =
  | 'invalid_response'
  | 'invalid_cache'
  | 'content_rejected'
  | 'provider_busy'
  | 'timeout'
  | 'storage_failure'
  | 'analysis_failed';
export class ImageAnalysisError extends Error {
  constructor(public readonly code: ImageAnalysisCode) {
    super(code);
  }
}

const metadataSchema = z.object({
  overallImageContent: z.enum(['photo', 'drawing', 'text']),
  description: z.string(),
  text: z.string(),
  characters: z.array(
    z.object({
      label: z.string(),
      type: z.string(),
      age: z.string().optional(),
      physicalDescription: z.string(),
      box_2d: z.array(z.number().finite().int().min(0).max(1000)).length(4),
    }),
  ),
});

function providerError(error: unknown): ImageAnalysisError {
  if (error instanceof ImageAnalysisError) return error;
  const value = error as { status?: number; code?: number | string; message?: string } | null;
  if (value?.status === 429 || value?.status === 503 || value?.code === 429 || value?.code === 503)
    return new ImageAnalysisError('provider_busy');
  if (/safety|blocked|content.?filter/i.test(value?.message ?? ''))
    return new ImageAnalysisError('content_rejected');
  return new ImageAnalysisError('analysis_failed');
}

const ANALYSIS_TIMEOUT_MS = 50000; // 50s, matching the character-photo analysis budget

export interface DetectedCharacter {
  label: string;
  type: string;
  age?: string;
  physicalDescription: string;
  box_2d: Box2d;
}

export interface ImageMetadata {
  overallImageContent: 'photo' | 'drawing' | 'text';
  description: string;
  text: string;
  characters: DetectedCharacter[];
}

/**
 * Compute the sibling metadata path for an input object
 * (e.g. `{authorId}/inputs/{uuid}.jpg` -> `{authorId}/inputs/{uuid}.json`).
 */
export function metadataPathFor(objectPath: string): string {
  const slash = objectPath.lastIndexOf('/');
  const dot = objectPath.lastIndexOf('.');
  if (dot > slash) {
    return `${objectPath.slice(0, dot)}.json`;
  }
  return `${objectPath}.json`;
}

function normalizeMetadata(parsed: any): ImageMetadata {
  const allowedTypes = new Set(['photo', 'drawing', 'text']);
  const overallImageContent = allowedTypes.has(parsed?.overallImageContent)
    ? parsed.overallImageContent
    : 'photo';

  const characters: DetectedCharacter[] = Array.isArray(parsed?.characters)
    ? parsed.characters
        .filter((c: any) => c && Array.isArray(c.box_2d) && c.box_2d.length === 4)
        .map((c: any) => ({
          label: String(c.label ?? ''),
          type: String(c.type ?? ''),
          age: c.age != null ? String(c.age) : undefined,
          physicalDescription: String(c.physicalDescription ?? ''),
          box_2d: c.box_2d.map((n: any) => Number(n)) as Box2d,
        }))
    : [];

  return {
    overallImageContent,
    description: String(parsed?.description ?? ''),
    text: String(parsed?.text ?? ''),
    characters,
  };
}

/**
 * Analyse an input image stored in GCS and persist its metadata as a sibling
 * `.json`. Always re-runs analysis (use {@link loadOrAnalyzeMetadata} to reuse
 * an existing result). Returns the normalised metadata.
 */
export async function analyzeInputImage(
  objectPath: string,
  locale = 'en-US',
  opts?: ImageAnalysisOptions,
): Promise<ImageMetadata> {
  const storage = opts?.storage ?? getStorageService();

  const started = performance.now();
  const readPhoto = async () => {
    const meta = await storage
      .getFileMetadata(objectPath)
      .catch(() => ({ contentType: 'image/jpeg' as string | undefined }));
    const buffer = await storage.downloadFileAsBuffer(objectPath);
    return { buffer, mimeType: meta.contentType || 'image/jpeg' };
  };
  const photo = await (
    opts?.accessPrivateInput ? opts.accessPrivateInput(readPhoto) : readPhoto()
  ).catch(() => {
    throw new ImageAnalysisError('storage_failure');
  });
  if (!photo) throw new Error('Story draft is unavailable');
  const { buffer, mimeType } = photo;

  const downloaded = performance.now();
  const languageName = getLanguageName(locale);
  const promptTemplate = await PromptService.loadSharedPrompt('image-analysis');
  const { systemInstruction, userPrompt } = PromptService.buildParts(promptTemplate, {
    languageName,
    locale,
  });
  const schema = await SchemaService.loadSchema('image-metadata');

  const { service, provider } = aiGateway.getImageAnalysisTextService({
    authorId: opts?.authorId || 'system',
    storyId: 'image-analysis',
    action: 'image_analysis',
  });

  const modelStarted = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImageAnalysisError('timeout')), ANALYSIS_TIMEOUT_MS);
  });

  const analysisPromise = service.complete(userPrompt, {
    mediaParts: [{ mimeType, data: buffer }],
    jsonSchema: schema,
    maxTokens: 4096,
    // Object localisation / bounding boxes are a reasoning task: 'low' thinking
    // yields sloppy, overlapping boxes. 'high' markedly tightens them.
    thinkingLevel: 'high',
    mediaResolution: 'high', // OCR + bounding boxes benefit from full resolution
    systemInstruction,
    ...(opts?.privateContent ? { privateContent: true } : {}),
  });

  const raw = await Promise.race([analysisPromise, timeoutPromise])
    .catch((error: unknown) => {
      throw providerError(error);
    })
    .finally(() => clearTimeout(timer));
  const modelFinished = performance.now();
  let parsed: unknown;
  try {
    parsed = parseAIResponse(raw);
  } catch {
    throw new ImageAnalysisError('invalid_response');
  }
  const validated = metadataSchema.safeParse(parsed);
  if (!validated.success) throw new ImageAnalysisError('invalid_response');
  const metadata = normalizeMetadata(validated.data);

  // Persist sibling metadata JSON
  const jsonPath = metadataPathFor(objectPath);
  const writeMetadata = async () => {
    await storage.uploadFile(
      jsonPath,
      Buffer.from(JSON.stringify(metadata, null, 2)),
      'application/json',
      opts?.createOnly ? { ifGenerationMatch: 0 } : undefined,
    );
  };
  try {
    if (opts?.accessPrivateInput) {
      const result = await opts.accessPrivateInput(async () => {
        await writeMetadata();
        return true;
      });
      if (!result) throw new ImageAnalysisError('storage_failure');
    } else await writeMetadata();
  } catch (error) {
    if (opts?.createOnly && (error as { code?: number })?.code === 412) {
      try {
        const winner = metadataSchema.safeParse(JSON.parse(await storage.downloadFile(jsonPath)));
        if (winner.success) return normalizeMetadata(winner.data);
      } catch {
        /* report failed persistence below */
      }
    }
    throw new ImageAnalysisError('storage_failure');
  }

  logger.info('Image analysis complete', {
    requestId: opts?.requestId,
    assetId: opts?.assetId,
    downloadMs: Math.round(downloaded - started),
    inferenceMs: Math.round(modelFinished - modelStarted),
    persistMs: Math.round(performance.now() - modelFinished),
    inputBytes: buffer.length,
    provider,
    type: metadata.overallImageContent,
    characterCount: metadata.characters.length,
  });

  return metadata;
}

/**
 * Return the metadata for an input image, reusing the persisted `.json` when it
 * exists and analysing on demand otherwise. Returns `null` if analysis fails
 * (callers can proceed without that image's metadata).
 */
export async function loadOrAnalyzeMetadata(
  objectPath: string,
  locale = 'en-US',
  opts?: ImageAnalysisOptions,
): Promise<ImageMetadata | null> {
  const storage = opts?.storage ?? getStorageService();
  const jsonPath = metadataPathFor(objectPath);

  try {
    const readCachedMetadata = async () => {
      if (!(await storage.fileExists(jsonPath))) return null;
      return normalizeMetadata(JSON.parse(await storage.downloadFile(jsonPath)));
    };
    const cached = opts?.accessPrivateInput
      ? await opts.accessPrivateInput(readCachedMetadata)
      : await readCachedMetadata();
    if (cached === undefined && opts?.accessPrivateInput) return null;
    if (cached) return cached;
  } catch (error) {
    logger.warn('Failed to read existing image metadata; will re-analyse', {
      jsonPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return await analyzeInputImage(objectPath, locale, opts);
  } catch (error) {
    logger.error('Image analysis failed', {
      objectPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Reuse completed metadata after a lost response and coalesce simultaneous retries in this instance.
const pendingAnalyses = new Map<string, Promise<ImageMetadata>>();
export async function recoverableImageAnalysis(
  objectPath: string,
  locale: string,
  opts?: ImageAnalysisOptions,
): Promise<ImageMetadata> {
  const existing = pendingAnalyses.get(objectPath);
  if (existing) return existing;
  const work = (async () => {
    const storage = opts?.storage ?? getStorageService();
    try {
      const path = metadataPathFor(objectPath);
      if (await storage.fileExists(path)) {
        const data = await storage.downloadFile(path);
        let cached: unknown;
        try {
          cached = JSON.parse(data);
        } catch {
          throw new ImageAnalysisError('invalid_cache');
        }
        const valid = metadataSchema.safeParse(cached);
        if (valid.success) return normalizeMetadata(valid.data);
        throw new ImageAnalysisError('invalid_cache');
      }
    } catch (error) {
      if (error instanceof ImageAnalysisError) throw error;
      throw new ImageAnalysisError('storage_failure');
    }
    return analyzeInputImage(objectPath, locale, { ...opts, createOnly: true });
  })();
  pendingAnalyses.set(objectPath, work);
  try {
    return await work;
  } finally {
    if (pendingAnalyses.get(objectPath) === work) pendingAnalyses.delete(objectPath);
  }
}
