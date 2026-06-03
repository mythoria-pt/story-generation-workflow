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
import type { Box2d } from '@/utils/imageProcessing.js';

const aiGateway = getAIGatewayWithTokenTracking();
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
  opts?: { authorId?: string },
): Promise<ImageMetadata> {
  const storage = getStorageService();

  const meta = await storage
    .getFileMetadata(objectPath)
    .catch(() => ({ contentType: 'image/jpeg' as string | undefined }));
  const buffer = await storage.downloadFileAsBuffer(objectPath);
  const mimeType = meta.contentType || 'image/jpeg';

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

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Image analysis request timed out')), ANALYSIS_TIMEOUT_MS);
  });

  const analysisPromise = service.complete(userPrompt, {
    mediaParts: [{ mimeType, data: buffer }],
    jsonSchema: schema,
    temperature: 1, // Gemini 3 recommended default
    maxTokens: 4096,
    // Object localisation / bounding boxes are a reasoning task: 'low' thinking
    // yields sloppy, overlapping boxes. 'high' markedly tightens them.
    thinkingLevel: 'high',
    mediaResolution: 'high', // OCR + bounding boxes benefit from full resolution
    systemInstruction,
  });

  const raw = await Promise.race([analysisPromise, timeoutPromise]);
  const parsed = parseAIResponse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid image metadata response from AI');
  }

  const metadata = normalizeMetadata(parsed);

  // Persist sibling metadata JSON
  const jsonPath = metadataPathFor(objectPath);
  await storage.uploadFile(
    jsonPath,
    Buffer.from(JSON.stringify(metadata, null, 2)),
    'application/json',
  );

  logger.info('Image analysis complete', {
    objectPath,
    jsonPath,
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
  opts?: { authorId?: string },
): Promise<ImageMetadata | null> {
  const storage = getStorageService();
  const jsonPath = metadataPathFor(objectPath);

  try {
    if (await storage.fileExists(jsonPath)) {
      const content = await storage.downloadFile(jsonPath);
      return normalizeMetadata(JSON.parse(content));
    }
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
