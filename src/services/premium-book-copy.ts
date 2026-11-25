import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Bucket } from '@google-cloud/storage';
import { getDatabase } from '@/db/connection.js';
import { addPremiumPagePreviews } from './premium-book-previews.js';
import { stories } from '@/db/schema/index.js';
import {
  PremiumBookError,
  premiumManifest,
  premiumRevisionPrefix,
  readPremiumMarker,
  type PremiumAsset,
  type PremiumManifest,
} from './premium-book-contract.js';
import {
  getPremiumBucket,
  readPremiumManifest,
  savePremiumObject,
  verifyPremiumAssetScope,
} from './premium-book-storage.js';

// A replay of a copy command targets the same private book even after an HTTP timeout.
function copyId(identity: string) {
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 15) | 0x80;
  bytes[8] = (bytes.readUInt8(8) & 63) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export async function copyPremiumManifest(
  source: PremiumManifest,
  storyId: string,
  revision: string,
  copy: (asset: PremiumAsset) => Promise<PremiumAsset>,
) {
  const book = structuredClone(source);
  const assets = new Map<string, PremiumAsset>();
  for (const asset of [
    book.reference,
    book.motifArtwork,
    ...Object.values(book.covers),
    ...book.spreads.flatMap((s) => [s.source, s.master]),
    ...book.pages.flatMap((p) => [p.artwork, p.reading]),
  ]) {
    if (asset) {
      verifyPremiumAssetScope(source.storyId, asset);
      assets.set(asset.key, asset);
    }
  }
  const entries = [...assets.values()];
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.all(
      entries.slice(i, i + 4).map(async (ref) => assets.set(ref.key, await copy(ref))),
    );
  }
  const copied = (ref: PremiumAsset) => {
    const asset = assets.get(ref.key);
    if (!asset) throw new Error('Missing premium copy asset');
    return asset;
  };
  book.reference = copied(book.reference);
  if (book.motifArtwork) book.motifArtwork = copied(book.motifArtwork);
  book.covers = { front: copied(book.covers.front), back: copied(book.covers.back) };
  for (const spread of book.spreads) {
    spread.source = copied(spread.source);
    spread.master = copied(spread.master);
  }
  for (const page of book.pages) {
    if (page.artwork) page.artwork = copied(page.artwork);
    if (page.reading) page.reading = copied(page.reading);
  }
  delete book.previousRevision;
  delete book.supersedes;
  return premiumManifest.parse({ ...book, storyId, revision });
}

async function copyImage(
  bucket: Bucket,
  prefix: string,
  asset: PremiumAsset,
): Promise<PremiumAsset> {
  const source = bucket.file(asset.key, { generation: asset.generation });
  const key = prefix + '/assets/' + asset.key.split('/').pop();
  const dest = bucket.file(key);
  try {
    await source.copy(dest, { preconditionOpts: { ifGenerationMatch: 0 } });
  } catch (error) {
    if (Number((error as { code?: number }).code) !== 412) throw error;
  }
  const [[original], [result]] = await Promise.all([source.getMetadata(), dest.getMetadata()]);
  if (
    !original.crc32c ||
    original.crc32c !== result.crc32c ||
    Number(result.size) !== asset.bytes ||
    !result.generation
  )
    throw new Error('Premium copy integrity check failed');
  return { ...asset, key, generation: String(result.generation) };
}

export async function duplicatePremiumBook(
  sourceId: string,
  ownerId: string,
  revision: string,
  intentId: string,
) {
  const db = getDatabase();
  const [source] = await db
    .select()
    .from(stories)
    .where(
      and(
        eq(stories.storyId, sourceId),
        eq(stories.authorId, ownerId),
        eq(stories.status, 'published'),
      ),
    );
  const storyId = copyId([sourceId, ownerId, intentId].join('/'));
  const copyRevision = copyId(storyId + '/edition');
  const prefix = premiumRevisionPrefix(storyId, copyRevision);
  const existing = await db
    .select({ id: stories.storyId })
    .from(stories)
    .where(and(eq(stories.storyId, storyId), eq(stories.authorId, ownerId)));
  if (existing.length) return { storyId };
  const marker = readPremiumMarker(source?.features);
  if (!source || marker?.state !== 'published' || marker.revision !== revision)
    throw new PremiumBookError(409, 'premium_copy_source', 'The source edition changed');
  const bucket = await getPremiumBucket();
  const original = await readPremiumManifest(bucket, sourceId, ownerId, revision, marker.manifest);
  const book = await copyPremiumManifest(original, storyId, copyRevision, (ref) =>
    copyImage(bucket, prefix, ref),
  );
  await addPremiumPagePreviews(bucket, prefix, book);
  const manifest = await savePremiumObject(
    bucket,
    prefix + '/manifest.json',
    Buffer.from(JSON.stringify(book)),
    'application/json',
  );
  await db
    .insert(stories)
    .values({
      storyId,
      authorId: ownerId,
      title: source.title,
      plotDescription: source.plotDescription,
      storyLanguage: source.storyLanguage,
      synopsis: source.synopsis,
      place: source.place,
      additionalRequests: source.additionalRequests,
      imageGenerationInstructions: source.imageGenerationInstructions,
      targetAudience: source.targetAudience,
      novelStyle: source.novelStyle,
      graphicalStyle: source.graphicalStyle,
      customAuthor: source.customAuthor,
      dedicationMessage: source.dedicationMessage,
      chapterCount: source.chapterCount,
      status: 'published',
      isPublic: false,
      features: { premiumBook: { ...marker, revision: copyRevision, manifest } },
    })
    .onConflictDoNothing({ target: stories.storyId });
  return { storyId };
}
