import { Storage, type Bucket } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import { convertToAbsoluteImagePath } from '@/utils/imageUtils.js';
import { StoryService } from './story.js';
import {
  legacySquarePackage,
  publishedPremium,
  squarePackage,
  validatePremiumManifest,
  renderSquarePdf,
  assertSquareCasewrap,
} from './premium-order-proof.js';
import {
  PRINT_ASSET_BUCKET,
  PrintService,
  printLogoUrl,
  printQrUrl,
  type PrintArtwork,
} from './print.js';
import { PrintQualityService } from './print-quality.js';
import { CMYKConversionService } from './cmyk-conversion.js';
import {
  finishLuluPdf,
  inspectLuluAssets,
  loadSrgbProfile,
  luluInterior,
  luluSpinePoints,
} from './lulu-print-profile.js';

import { getPremiumBucket, readPremiumObject } from './premium-book-storage.js';

export const OrderProofRequest = z
  .object({
    orderId: z.string().uuid(),
    runId: z.string().uuid(),
    storyId: z.string().uuid(),
    provider: z.enum(['manual', 'lulu']),
    binding: z.enum(['paperback', 'hardcover']),
    premiumBook: publishedPremium.optional(),
    premiumPageCount: z.union([z.literal(32), z.literal(33)]).optional(),
    podPackageId: z.enum([squarePackage, legacySquarePackage]).optional(),
    coverDimensions: z
      .object({ width: z.number().min(800).max(1500), height: z.number().min(600).max(900) })
      .optional(),
    coverPageCount: z.literal([32, 33, 34]).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (!v.premiumBook && !v.podPackageId && !v.premiumPageCount) ||
      Boolean(
        v.premiumBook &&
        (v.provider === 'manual' || v.podPackageId) &&
        v.binding === 'hardcover' &&
        v.premiumBook.manifest.key ===
          v.storyId + '/premium/revisions/' + v.premiumBook.revision + '/manifest.json',
      ),
    {
      message:
        'Square orders require a published hardcover edition and, for Lulu, a square package',
    },
  )
  .refine((value) => value.provider === 'lulu' || !value.coverDimensions, {
    message: 'Manual print uses local cover dimensions',
  })
  .refine(
    (value) =>
      value.coverPageCount === undefined ||
      Boolean(
        value.provider === 'lulu' &&
        value.premiumBook &&
        value.coverDimensions &&
        (value.coverPageCount === value.premiumPageCount ||
          (value.premiumPageCount === 33 && value.coverPageCount === 34)),
      ),
    {
      message:
        'Square Lulu cover page count must match the source or include one final blank on a 33-page source',
    },
  );
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
  coverPageCount?: number;
};
type Story = NonNullable<Awaited<ReturnType<StoryService['getStoryForPrint']>>>;
type ArtworkReference = { artifact: Artifact; contentType: string };
type Source = { story: Story; artwork: Record<string, ArtworkReference> };
type Dimensions = { width: number; height: number };
type CompleteResult = Required<Omit<Result, 'coverPageCount'>>;
type Final = {
  result: CompleteResult;
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

async function saveArtifact(
  bucket: Bucket,
  prefix: string,
  name: string,
  bytes: Buffer,
  contentType: string,
): Promise<Artifact> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const object = `${prefix}/${sha256}/${name}`;
  const file = bucket.file(object);
  try {
    await file.save(bytes, {
      contentType,
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

async function readArtifact(bucket: Bucket, artifact: Artifact): Promise<Buffer> {
  const [bytes] = await bucket
    .file(artifact.object, { generation: artifact.generation })
    .download();
  if (
    bytes.length !== artifact.size ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error('Proof artifact failed integrity verification');
  return bytes;
}

function normalizeArtworkUrl(uri: string): string {
  const source = uri.startsWith('gs://')
    ? 'https://storage.googleapis.com/' + uri.slice('gs://'.length)
    : convertToAbsoluteImagePath(uri);
  const url = new URL(source);
  if (
    url.origin !== 'https://storage.googleapis.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/.+/.test(url.pathname)
  )
    throw new Error('Print artwork must be a Google Storage object');
  return url.href;
}

async function freezeSource(
  bucket: Bucket,
  prefix: string,
  storyId: string,
  loadArtwork: (url: string) => Promise<PrintArtwork>,
): Promise<Source> {
  const source = await new StoryService().getStoryForPrint(storyId);
  if (!source || !source.chapters.length) throw new Error('Story has no printable content');
  if (!source.coverUri) throw new Error('Story has no front cover');
  const story = {
    ...source,
    coverUri: normalizeArtworkUrl(source.coverUri),
    backcoverUri: source.backcoverUri ? normalizeArtworkUrl(source.backcoverUri) : null,
    chapters: source.chapters.map((chapter: Story['chapters'][number]) => ({
      ...chapter,
      imageUri: chapter.imageUri ? normalizeArtworkUrl(chapter.imageUri) : null,
    })),
  };
  const artwork: Source['artwork'] = {};
  const sources = new Set([
    story.coverUri,
    story.backcoverUri,
    printQrUrl,
    printLogoUrl(story.graphicalStyle),
    ...story.chapters.map((chapter: Story['chapters'][number]) => chapter.imageUri),
  ]);
  for (const url of sources) {
    if (!url) continue;
    const { bytes, contentType } = await loadArtwork(url);
    artwork[url] = {
      artifact: await saveArtifact(bucket, prefix, 'artwork', bytes, contentType),
      contentType,
    };
  }
  return { story, artwork };
}

export async function prepareOrderProof(request: Request): Promise<Result> {
  const env = getEnvironment();
  if (
    !env.PRINT_PROOF_BUCKET ||
    env.PRINT_PROOF_BUCKET === env.STORAGE_BUCKET_NAME ||
    env.PRINT_PROOF_BUCKET === PRINT_ASSET_BUCKET
  )
    throw new Error('Private proof storage must be configured');
  const storage = new Storage({ projectId: env.GOOGLE_CLOUD_PROJECT_ID });
  const allowedBuckets = new Set([env.STORAGE_BUCKET_NAME, PRINT_ASSET_BUCKET]);
  const premiumBucket = env.PREMIUM_BOOK_BUCKET;
  if (request.premiumBook && (!premiumBucket || allowedBuckets.has(premiumBucket)))
    throw new Error('Private premium storage must be configured');
  return renderOrderProof(
    storage.bucket(env.PRINT_PROOF_BUCKET),
    request,
    async (url) => {
      const [, bucket, ...path] = new URL(url).pathname.split('/');
      if (!bucket || !allowedBuckets.has(bucket) || !path.length)
        throw new Error('Unexpected print artwork bucket');
      const [bytes] = await storage
        .bucket(bucket)
        .file(decodeURIComponent(path.join('/')))
        .download();
      const { format } = await sharp(bytes).metadata();
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp')
        throw new Error('Unsupported print artwork format');
      return { bytes, contentType: 'image/' + format };
    },
    request.premiumBook ? await getPremiumBucket() : undefined,
  );
}

export async function renderOrderProof(
  bucket: Bucket,
  request: Request,
  loadArtwork: (url: string) => Promise<PrintArtwork>,
  premiumBucket?: Bucket,
): Promise<Result> {
  const orderRun = ['print-orders', request.orderId, request.runId].join('/');
  const prefix = [orderRun, request.provider, request.binding, request.storyId].join('/');
  const lulu = request.provider === 'lulu';
  if (request.premiumBook) {
    const pin = request.premiumBook;
    if (!premiumBucket) throw new Error('Missing premium storage');
    const prior = await stage(bucket, orderRun + '/premium-source.json', async () => {
      // Before the run-wide pin, square proofs stored the source under the Lulu profile.
      const priorLulu = await readJson<typeof pin>(
        bucket,
        `${orderRun}/lulu/hardcover/${request.storyId}/premium-source.json`,
      );
      return priorLulu ?? pin;
    });
    if (
      prior.revision !== pin.revision ||
      prior.manifest.sha256 !== pin.manifest.sha256 ||
      prior.manifest.generation !== pin.manifest.generation ||
      prior.manifest.key !== pin.manifest.key ||
      prior.manifest.bytes !== pin.manifest.bytes
    )
      throw new Error('Another edition is already pinned to this proof version');
    const manifest = validatePremiumManifest(
      JSON.parse((await readPremiumObject(premiumBucket, pin.manifest)).toString('utf8')),
      request.storyId,
      pin.revision,
    );
    if (manifest.readingProof)
      throw new Error('Reading proof editions are unavailable for print orders');
    const pageCount = manifest.format.pageCount;
    if (request.premiumPageCount !== undefined && request.premiumPageCount !== pageCount)
      throw new Error('Premium proof page count differs from the paid edition');
    const dir = await mkdtemp(join(tmpdir(), 'mythoria-square-proof-'));
    try {
      const coverPageCount = request.coverPageCount ?? pageCount;
      if (request.coverDimensions) assertSquareCasewrap(request.coverDimensions, coverPageCount);
      const renderOptions =
        lulu && request.coverDimensions
          ? {
              coverDimensions: request.coverDimensions,
              lulu: true,
              ...(request.coverPageCount === undefined ? {} : { coverPageCount }),
            }
          : lulu
            ? { lulu: true }
            : undefined;
      const render = (part: 'interior' | 'cover') =>
        renderOptions
          ? renderSquarePdf(
              manifest,
              dir,
              part,
              (ref) => readPremiumObject(premiumBucket, ref),
              loadArtwork,
              renderOptions,
            )
          : renderSquarePdf(
              manifest,
              dir,
              part,
              (ref) => readPremiumObject(premiumBucket, ref),
              loadArtwork,
            );
      const interior = await stage<Interior>(bucket, prefix + '/square-interior.json', async () => {
        const { bytes, issues } = await render('interior');
        return {
          interior: await saveArtifact(bucket, prefix, 'interior.pdf', bytes, 'application/pdf'),
          pageCount,
          imageIssues: issues,
        };
      });
      if (interior.pageCount !== pageCount)
        throw new Error('Cached interior has a different page count');
      if (lulu && !request.coverDimensions) return { interior: interior.interior, pageCount };
      const normalizedSquareCover = request.coverPageCount !== undefined;
      if (normalizedSquareCover && request.coverDimensions) {
        const parameters = { dimensions: request.coverDimensions, pageCount: coverPageCount };
        const staged = await stage(
          bucket,
          prefix + '/square-lulu-cover-parameters.json',
          async () => parameters,
        );
        if (
          staged.pageCount !== parameters.pageCount ||
          staged.dimensions.width !== parameters.dimensions.width ||
          staged.dimensions.height !== parameters.dimensions.height
        )
          throw new Error('Existing proof uses different cover parameters');
      } else if (lulu && request.coverDimensions) {
        const requestedCover = request.coverDimensions;
        const stagedDims = await stage<Dimensions>(
          bucket,
          prefix + '/square-dimensions.json',
          async () => requestedCover,
        );
        if (
          stagedDims.width !== request.coverDimensions.width ||
          stagedDims.height !== request.coverDimensions.height
        ) {
          throw new Error('Existing proof uses different dimensions');
        }
      }
      const finalManifest = normalizedSquareCover
        ? '/square-lulu-final.json'
        : '/square-final.json';
      return await stage<CompleteResult & Pick<Result, 'coverPageCount'>>(
        bucket,
        prefix + finalManifest,
        async () => {
          const { bytes, issues: coverIssues } = await render('cover');
          const issues = [...new Set([...interior.imageIssues, ...coverIssues])];
          return {
            interior: interior.interior,
            cover: await saveArtifact(bucket, prefix, 'cover.pdf', bytes, 'application/pdf'),
            pageCount,
            qaPassed: issues.length === 0,
            qaCriticalCount: issues.length,
            issues,
            ...(normalizedSquareCover ? { coverPageCount } : {}),
          };
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { story, artwork } = await stage(bucket, prefix + '/source.json', () =>
    freezeSource(bucket, prefix, request.storyId, loadArtwork),
  );
  const print = new PrintService(lulu ? request.binding : undefined, async (url) => {
    const reference = artwork[url];
    if (!reference) return undefined;
    return {
      bytes: await readArtifact(bucket, reference.artifact),
      contentType: reference.contentType,
    };
  });
  const dir = await mkdtemp(join(tmpdir(), 'mythoria-order-proof-'));
  try {
    const interior = await stage<Interior>(bucket, prefix + '/interior.json', async () => {
      const variant = await print.generateInteriorVariant(story, join(dir, 'interior.pdf'));
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
      const pageCount = (await PDFDocument.load(bytes)).getPageCount();
      return {
        interior: await saveArtifact(bucket, prefix, 'interior.pdf', bytes, 'application/pdf'),
        pageCount,
        imageIssues,
      };
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
        if ((await PDFDocument.load(bytes)).getPageCount() !== 1)
          throw new Error('Cover must contain one spread');
      }
      const frozen = interior.interior;
      const interiorPdfBuffer = await readArtifact(bucket, frozen);
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
          cover: await saveArtifact(bucket, prefix, 'cover.pdf', bytes, 'application/pdf'),
          qaPassed: critical.length === 0,
          qaCriticalCount: critical.length,
          issues: [...new Set(issues)],
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
