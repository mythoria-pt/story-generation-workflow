import { Storage, type Bucket } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import { StoryService } from './story.js';
import { PrintService } from './print.js';
import { PrintQualityService } from './print-quality.js';
import { CMYKConversionService } from './cmyk-conversion.js';
import {
  finishLuluPdf,
  inspectLuluAssets,
  loadSrgbProfile,
  luluInterior,
  luluSpinePoints,
} from './lulu-print-profile.js';

export const OrderProofRequest = z
  .object({
    orderId: z.string().uuid(),
    runId: z.string().uuid(),
    storyId: z.string().uuid(),
    provider: z.enum(['manual', 'lulu']),
    binding: z.enum(['paperback', 'hardcover']),
    coverDimensions: z
      .object({ width: z.number().min(800).max(1400), height: z.number().min(600).max(900) })
      .optional(),
  })
  .strict()
  .refine((value) => value.provider === 'lulu' || !value.coverDimensions, {
    message: 'Manual print uses local cover dimensions',
  });
type Request = z.infer<typeof OrderProofRequest>;
type Artifact = {
  bucket: string;
  object: string;
  generation: string;
  size: number;
  sha256: string;
};
type Interior = { interior: Artifact; pageCount: number; imageIssues: string[] };
type Result = {
  interior: Artifact;
  pageCount: number;
  cover?: Artifact;
  qaPassed?: boolean;
  qaCriticalCount?: number;
  issues?: string[];
};
type Story = NonNullable<Awaited<ReturnType<StoryService['getStoryForPrint']>>>;
type Dimensions = { width: number; height: number };
type Final = {
  result: Required<Result>;
  dimensions: Dimensions | null;
};
const hasCode = (error: unknown, code: number) =>
  typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === code;

async function readJson<T>(bucket: Bucket, name: string): Promise<T | undefined> {
  try {
    const [bytes] = await bucket.file(name).download();
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch (error) {
    if (hasCode(error, 404)) return undefined;
    throw error;
  }
}

// The first completed write elects the version for every caller, including
// retries after timeouts. A competing render never overwrites the winner.
async function stage<T>(bucket: Bucket, name: string, generate: () => Promise<T>): Promise<T> {
  const prior = await readJson<T>(bucket, name);
  if (prior !== undefined) return prior;
  const result = await generate();
  try {
    await bucket.file(name).save(JSON.stringify(result), {
      contentType: 'application/json',
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return result;
  } catch (error) {
    if (!hasCode(error, 412)) throw error;
    const winner = await readJson<T>(bucket, name);
    if (!winner) throw error;
    return winner;
  }
}

async function savePdf(
  bucket: Bucket,
  prefix: string,
  name: string,
  bytes: Buffer,
): Promise<Artifact> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const object = prefix + '/' + sha256 + '/' + name + '.pdf';
  const file = bucket.file(object);
  try {
    await file.save(bytes, {
      contentType: 'application/pdf',
      metadata: { cacheControl: 'private,no-store' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (error) {
    if (!hasCode(error, 412)) throw error;
  }
  const [metadata] = await file.getMetadata();
  if (!metadata.generation || Number(metadata.size) !== bytes.length)
    throw new Error('Proof object verification failed');
  return {
    bucket: bucket.name,
    object,
    generation: String(metadata.generation),
    size: bytes.length,
    sha256,
  };
}

export async function prepareOrderProof(request: Request): Promise<Result> {
  const env = getEnvironment();
  if (!env.PRINT_PROOF_BUCKET || env.PRINT_PROOF_BUCKET === env.STORAGE_BUCKET_NAME)
    throw new Error('Private proof storage must be configured');
  const bucket = new Storage({ projectId: env.GOOGLE_CLOUD_PROJECT_ID }).bucket(
    env.PRINT_PROOF_BUCKET,
  );
  return renderOrderProof(bucket, request);
}

export async function renderOrderProof(bucket: Bucket, request: Request): Promise<Result> {
  const prefix = [
    'print-orders',
    request.orderId,
    request.runId,
    request.provider,
    request.binding,
    request.storyId,
  ].join('/');
  const lulu = request.provider === 'lulu';
  const print = new PrintService(lulu ? request.binding : undefined, true);
  const story = await stage<Story>(bucket, prefix + '/source.json', async () => {
    const source = await new StoryService().getStoryForPrint(request.storyId);
    if (!source || !source.chapters.length) throw new Error('Story has no printable content');
    if (!source.coverUri) throw new Error('Story has no front cover');
    return source;
  });
  const dir = await mkdtemp(join(tmpdir(), 'mythoria-order-proof-'));
  try {
    const interior = await stage<Interior>(bucket, prefix + '/interior.json', async () => {
      const variant = await print.generateInteriorVariant(story, join(dir, 'interior.pdf'));
      const rgb = await readFile(variant.interiorPdfPath);
      const pageCount = (await PDFDocument.load(rgb)).getPageCount();
      let bytes: Buffer;
      let imageIssues: string[] = [];
      if (lulu) {
        const flat = join(dir, 'interior-flat.pdf');
        await new CMYKConversionService().flattenForLulu(variant.interiorPdfPath, flat);
        bytes = await finishLuluPdf(
          await readFile(flat),
          luluInterior,
          true,
          await loadSrgbProfile(),
        );
        const finalPath = join(dir, 'interior-final.pdf');
        await writeFile(finalPath, bytes);
        imageIssues = await inspectLuluAssets(finalPath);
      } else {
        const path = await print.convertInteriorToCMYK(
          variant.interiorPdfPath,
          story,
          variant.imagePageNumbers,
        );
        bytes = await readFile(path);
      }
      return { interior: await savePdf(bucket, prefix, 'interior', bytes), pageCount, imageIssues };
    });
    const { pageCount } = interior;
    if (lulu && !request.coverDimensions) return { pageCount, interior: interior.interior };
    const requested = request.coverDimensions ?? null;
    const final = await stage<Final>(bucket, prefix + '/final.json', async () => {
      const dimensions = print.calculateDimensions(pageCount);
      if (lulu && requested) {
        const spine = luluSpinePoints(request.binding, pageCount, requested.width);
        if (request.binding === 'paperback' && Math.abs(requested.height - luluInterior.height) > 2)
          throw new Error('Unexpected paperback height');
        if (request.binding === 'hardcover' && requested.height < luluInterior.height + 72)
          throw new Error('Unexpected casewrap height');
        dimensions.coverSpreadWMM = (requested.width * 25.4) / 72;
        dimensions.coverSpreadHMM = (requested.height * 25.4) / 72;
        dimensions.spineWidthMM = (spine * 25.4) / 72;
      }
      const coverHtml = print.generateCoverHTML(story, dimensions);
      const coverPath = join(dir, 'cover.pdf');
      await print.renderPDF(coverHtml, {
        width: dimensions.coverSpreadWMM,
        height: dimensions.coverSpreadHMM,
        outputPath: coverPath,
      });
      let bytes: Buffer;
      const issues = [...interior.imageIssues];
      if (lulu && requested) {
        const flat = join(dir, 'cover-flat.pdf');
        await new CMYKConversionService().flattenForLulu(coverPath, flat);
        bytes = await finishLuluPdf(
          await readFile(flat),
          requested,
          false,
          await loadSrgbProfile(),
        );
        const finalPath = join(dir, 'cover-final.pdf');
        await writeFile(finalPath, bytes);
        issues.push(...(await inspectLuluAssets(finalPath)));
      } else {
        const path = await new CMYKConversionService().convertToCMYK({
          inputPath: coverPath,
          outputPath: join(dir, 'cover-cmyk.pdf'),
        });
        bytes = await readFile(path);
      }
      const frozen = interior.interior;
      const [interiorPdfBuffer] = await bucket
        .file(frozen.object, { generation: frozen.generation })
        .download();
      if (createHash('sha256').update(interiorPdfBuffer).digest('hex') !== frozen.sha256)
        throw new Error('Incorrect interior object');
      const qa = await new PrintQualityService().runDeterministicChecks(story, {
        interiorPdfBuffer,
        interiorHtml: print.generateInteriorHTML(story, dimensions),
        coverHtml,
      });
      issues.push(...qa.criticalErrors.map((i) => i.code));
      const critical = issues.filter((issue) => issue !== 'image_below_300_ppi');
      return {
        dimensions: requested,
        result: {
          pageCount,
          interior: frozen,
          cover: await savePdf(bucket, prefix, 'cover', bytes),
          qaPassed: critical.length === 0,
          qaCriticalCount: critical.length,
          issues,
        },
      };
    });
    if (
      final.dimensions?.width !== requested?.width ||
      final.dimensions?.height !== requested?.height
    )
      throw new Error('Existing proof uses different dimensions');
    return final.result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
