import type { Bucket } from '@google-cloud/storage';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { productGenerationRequests } from '@/db/schema/index.js';
import { logger } from '@/config/logger.js';
import { CMYKConversionService } from './cmyk-conversion.js';
import { premiumAsset, premiumRevisionPrefix, type PremiumAsset } from './premium-book-contract.js';
import {
  getPremiumBucket,
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumManifest,
  readPremiumObject,
  savePremiumObject,
  stagePremiumCheckpoint,
} from './premium-book-storage.js';
import {
  casewrap,
  loadPremiumPublicationQr,
  renderSquarePdf,
  validatePremiumManifest,
} from './premium-order-proof.js';

export const premiumSelfPrintSource = z.object({
  ownerId: z.uuid(),
  revision: z.uuid(),
  manifest: premiumAsset,
  generateCMYK: z.boolean(),
});
export type PremiumSelfPrintSource = z.infer<typeof premiumSelfPrintSource>;

export function readPremiumSelfPrintSource(metadata: unknown) {
  return metadata && typeof metadata === 'object' && 'premiumSelfPrint' in metadata
    ? premiumSelfPrintSource.parse(metadata.premiumSelfPrint)
    : undefined;
}

// This fits the existing 255-character pending queue reference in the WebApp request.
function pendingReference(source: PremiumSelfPrintSource) {
  const { revision, manifest } = source;
  return `premium-self-print:v1:${revision}:${manifest.generation}:${manifest.sha256}:${manifest.bytes}:${source.generateCMYK ? '1' : '0'}`;
}

export async function findPremiumSelfPrintFunding(
  storyId: string,
  runId: string,
  source: PremiumSelfPrintSource,
  allowAccepted = false,
) {
  if (source.manifest.key !== `${premiumRevisionPrefix(storyId, source.revision)}/manifest.json`)
    return null;
  const [request] = await getDatabase()
    .select()
    .from(productGenerationRequests)
    .where(eq(productGenerationRequests.runId, runId));
  if (
    !request ||
    request.storyId !== storyId ||
    request.authorId !== source.ownerId ||
    request.actionType !== 'self_print' ||
    request.compensatedAt
  )
    return null;
  if (request.status === 'pending')
    return request.queueReference === pendingReference(source) ? request : null;
  return allowAccepted && ['queued', 'running', 'completed'].includes(request.status)
    ? request
    : null;
}
const pdfPackage = z.object({
  interior: premiumAsset,
  cover: premiumAsset,
  interiorCmyk: premiumAsset.nullable(),
  coverCmyk: premiumAsset.nullable(),
});
type PdfPackage = z.infer<typeof pdfPackage>;
export const premiumPrintPart = z.enum(['interior', 'cover', 'interiorCmyk', 'coverCmyk']);
export type PremiumPrintPart = z.infer<typeof premiumPrintPart>;
export const adminPremiumPrintRenderer = 'v1';
type PrintScope = 'self-print' | 'admin';

const prefixFor = (
  storyId: string,
  revision: string,
  runId: string,
  scope: PrintScope = 'self-print',
) =>
  `${premiumRevisionPrefix(storyId, revision)}/${scope === 'admin' ? `admin-print/${adminPremiumPrintRenderer}` : 'self-print'}/${z.uuid().parse(runId)}`;

const pdfKey = (prefix: string, label: keyof PdfPackage, hash: string) =>
  `${prefix}/${hash}/${label}.pdf`;

async function assetLinks(
  pdfs: PdfPackage,
  url: (asset: PremiumAsset, part: keyof PdfPackage) => Promise<string> | string,
) {
  const [interiorPdfUrl, coverPdfUrl, interiorCmykPdfUrl, coverCmykPdfUrl] = await Promise.all([
    url(pdfs.interior, 'interior'),
    url(pdfs.cover, 'cover'),
    pdfs.interiorCmyk ? url(pdfs.interiorCmyk, 'interiorCmyk') : null,
    pdfs.coverCmyk ? url(pdfs.coverCmyk, 'coverCmyk') : null,
  ]);
  return { interiorPdfUrl, coverPdfUrl, interiorCmykPdfUrl, coverCmykPdfUrl };
}

export async function renderPremiumSelfPrint(
  storyId: string,
  runId: string,
  source: PremiumSelfPrintSource,
) {
  return renderPremiumPrintPackage(storyId, runId, source, 'self-print');
}

export async function renderPremiumPrintPackage(
  storyId: string,
  runId: string,
  source: PremiumSelfPrintSource,
  scope: PrintScope,
) {
  const bucket = await getPremiumBucket();
  const prefix = prefixFor(storyId, source.revision, runId, scope);
  const pinned = await stagePremiumCheckpoint(
    bucket,
    `${prefix}/edition.json`,
    premiumSelfPrintSource,
    () => Promise.resolve(source),
  );
  if (!isDeepStrictEqual(pinned, source)) {
    throw new Error('Print source differs from the pinned edition');
  }

  const pdfs = await stagePremiumCheckpoint(bucket, `${prefix}/pdfs.json`, pdfPackage, async () => {
    const book = validatePremiumManifest(
      await readPremiumManifest(bucket, storyId, pinned.ownerId, pinned.revision, pinned.manifest),
      storyId,
      pinned.revision,
    );
    if (book.readingProof && scope !== 'admin')
      throw new Error('Reading proof editions are unavailable for paid printing');
    const dir = await mkdtemp(join(tmpdir(), 'mythoria-premium-self-print-'));
    try {
      const save = (label: keyof PdfPackage, bytes: Buffer) =>
        savePremiumObject(
          bucket,
          pdfKey(prefix, label, premiumDigest(bytes)),
          bytes,
          'application/pdf',
        );
      const render = async (part: 'interior' | 'cover') => {
        if (book.readingProof?.sourceRevision === book.revision) {
          const bytes = await readPremiumObject(bucket, book.readingProof[part]);
          await writeFile(join(dir, part + '.pdf'), bytes);
          return save(part, bytes);
        }
        const { bytes, issues } = await renderSquarePdf(
          book,
          dir,
          part,
          (asset) => readPremiumObject(bucket, asset),
          loadPremiumPublicationQr,
        );
        if (issues.length)
          throw new Error(`Premium self-print PDF failed QA: ${issues.join(', ')}`);
        return save(part, bytes);
      };
      const interior = await render('interior');
      const cover = await render('cover');
      if (!pinned.generateCMYK) return { interior, cover, interiorCmyk: null, coverCmyk: null };

      const converter = new CMYKConversionService();
      const output = await converter.convertPrintSetToCMYK(
        join(dir, 'interior.pdf'),
        join(dir, 'cover.pdf'),
        {
          title: book.opening.title,
          author: book.opening.author,
          subject: 'Square self-print book',
        },
      );
      const saveCmyk = async (
        label: 'interiorCmyk' | 'coverCmyk',
        path: string,
        count: number,
        width: number,
        height: number,
      ) => {
        const bytes = await readFile(path);
        const pages = (await PDFDocument.load(bytes)).getPages();
        if (
          pages.length !== count ||
          pages.some(
            (page) =>
              Math.abs(page.getWidth() - width) > 1 || Math.abs(page.getHeight() - height) > 1,
          )
        ) {
          throw new Error('CMYK conversion changed premium self-print page geometry');
        }
        return save(label, bytes);
      };
      const size = book.format.trimPoints + book.format.bleedPoints * 2;
      const interiorCmyk = await saveCmyk(
        'interiorCmyk',
        output.interiorCMYK,
        book.format.pageCount,
        size,
        size,
      );
      const coverCmyk = await saveCmyk(
        'coverCmyk',
        output.coverCMYK,
        1,
        casewrap.width,
        casewrap.height,
      );
      return { interior, cover, interiorCmyk, coverCmyk };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn('Failed to remove premium self-print temporary files', {
          storyId,
          runId,
          error,
        });
      });
    }
  });
  return {
    ...(await assetLinks(
      pdfs,
      (asset) => `https://storage.googleapis.com/${bucket.name}/${asset.key}`,
    )),
    premiumRevision: source.revision,
    status: 'completed',
  };
}

export async function signPremiumSelfPrint(storyId: string, runId: string, revision: string) {
  const bucket = await getPremiumBucket();
  const prefix = prefixFor(storyId, revision, runId);
  const pdfs = await readPremiumCheckpoint(bucket, `${prefix}/pdfs.json`, pdfPackage);
  if (!pdfs) throw new Error('Premium self-print package is missing');
  return assetLinks(pdfs, (asset, part) => signPdf(bucket, asset, prefix, part));
}

export async function getVerifiedPremiumPrintPackage(
  storyId: string,
  runId: string,
  source: PremiumSelfPrintSource,
  scope: PrintScope,
) {
  const bucket = await getPremiumBucket();
  const prefix = prefixFor(storyId, source.revision, runId, scope);
  const pdfs = await readPremiumCheckpoint(bucket, `${prefix}/edition.json`, premiumSelfPrintSource)
    .then((edition) => {
      if (!isDeepStrictEqual(edition, source)) return undefined;
      return readPremiumCheckpoint(bucket, `${prefix}/pdfs.json`, pdfPackage);
    })
    .catch((error: unknown) => {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return undefined;
      throw error;
    });
  if (!pdfs) return null;
  const parts = premiumPrintPart.options.filter((part) => pdfs[part] !== null);
  if (parts.length !== (source.generateCMYK ? 4 : 2)) return null;
  const valid = await Promise.all(
    parts.map(async (part) => {
      const asset = pdfs[part];
      if (!asset) return false;
      const file = pinnedPdfFile(bucket, asset, prefix, part);
      if (!file) return false;
      try {
        const [metadata] = await file.getMetadata();
        return (
          metadata.contentType === 'application/pdf' &&
          Number(metadata.size) === asset.bytes &&
          String(metadata.generation) === asset.generation
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && Number(error.code) === 404)
          return false;
        throw error;
      }
    }),
  );
  if (!valid.every(Boolean)) return null;
  return {
    parts,
    sign(part: PremiumPrintPart) {
      const asset = pdfs[part];
      return asset ? signPdf(bucket, asset, prefix, part, 5 * 60 * 1000) : null;
    },
  };
}

function pinnedPdfFile(
  bucket: Bucket,
  asset: PremiumAsset,
  prefix: string,
  part: PremiumPrintPart,
) {
  const generation = Number(asset.generation);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    String(generation) !== asset.generation ||
    asset.key !== pdfKey(prefix, part, asset.sha256)
  ) {
    return null;
  }
  return bucket.file(asset.key, { generation });
}

async function signPdf(
  bucket: Bucket,
  asset: PremiumAsset,
  prefix: string,
  part: keyof PdfPackage,
  lifetimeMs = 7 * 24 * 60 * 60 * 1000,
) {
  const file = pinnedPdfFile(bucket, asset, prefix, part);
  if (!file) throw new Error('Invalid premium print asset reference');
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + lifetimeMs,
    promptSaveAs: `${part}.pdf`,
  });
  return url;
}
