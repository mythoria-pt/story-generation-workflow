import type { Bucket } from '@google-cloud/storage';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
type PremiumSelfPrintSource = z.infer<typeof premiumSelfPrintSource>;

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

const prefixFor = (storyId: string, revision: string, runId: string) =>
  `${premiumRevisionPrefix(storyId, revision)}/self-print/${z.uuid().parse(runId)}`;

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
  const bucket = await getPremiumBucket();
  const prefix = prefixFor(storyId, source.revision, runId);
  const pinned = await stagePremiumCheckpoint(
    bucket,
    `${prefix}/edition.json`,
    premiumSelfPrintSource,
    () => Promise.resolve(source),
  );
  if (
    pinned.manifest.generation !== source.manifest.generation ||
    pinned.manifest.sha256 !== source.manifest.sha256 ||
    pinned.manifest.key !== source.manifest.key ||
    pinned.manifest.bytes !== source.manifest.bytes ||
    pinned.revision !== source.revision ||
    pinned.ownerId !== source.ownerId ||
    pinned.generateCMYK !== source.generateCMYK
  ) {
    throw new Error('Self-print source differs from the pinned edition');
  }

  const pdfs = await stagePremiumCheckpoint(bucket, `${prefix}/pdfs.json`, pdfPackage, async () => {
    const book = validatePremiumManifest(
      await readPremiumManifest(bucket, storyId, pinned.ownerId, pinned.revision, pinned.manifest),
      storyId,
      pinned.revision,
    );
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

async function signPdf(
  bucket: Bucket,
  asset: PremiumAsset,
  prefix: string,
  part: keyof PdfPackage,
) {
  const generation = Number(asset.generation);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    String(generation) !== asset.generation ||
    asset.key !== pdfKey(prefix, part, asset.sha256)
  ) {
    throw new Error('Invalid premium self-print asset reference');
  }
  const [url] = await bucket.file(asset.key, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    promptSaveAs: `${part}.pdf`,
  });
  return url;
}
