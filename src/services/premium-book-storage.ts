import { createHash, randomUUID } from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import {
  PremiumBookError,
  premiumManifest,
  premiumRevisionPrefix,
  type PremiumAsset,
  type PremiumManifest,
} from './premium-book-contract.js';

export const premiumDigest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

const hasCode = (error: unknown, code: number) =>
  typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === code;

let storage: Storage | undefined;
let verifiedBucket: Promise<Bucket> | undefined;

export function getPremiumBucket(): Promise<Bucket> {
  const env = getEnvironment();
  if (!env.PREMIUM_BOOK_BUCKET || env.PREMIUM_BOOK_BUCKET === env.STORAGE_BUCKET_NAME) {
    throw new PremiumBookError(
      503,
      'premium_storage_unconfigured',
      'Dedicated premium storage unavailable',
    );
  }
  storage ??= new Storage({ projectId: env.GOOGLE_CLOUD_PROJECT_ID });
  const bucket = storage.bucket(env.PREMIUM_BOOK_BUCKET);
  verifiedBucket ??= Promise.all([
    bucket.getMetadata(),
    bucket.iam.getPolicy({ requestedPolicyVersion: 3 }),
  ])
    .then(([[metadata], [policy]]) => {
      if (
        !metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled ||
        metadata.iamConfiguration.publicAccessPrevention !== 'enforced' ||
        policy.bindings?.some((binding) =>
          binding.members.some(
            (member) => member === 'allUsers' || member === 'allAuthenticatedUsers',
          ),
        )
      ) {
        throw new PremiumBookError(
          503,
          'premium_storage_public',
          'Premium storage must enforce private access',
        );
      }
      return bucket;
    })
    .catch((error: unknown) => {
      verifiedBucket = undefined;
      throw error;
    });
  return verifiedBucket;
}

export async function savePremiumObject(
  bucket: Bucket,
  key: string,
  bytes: Buffer,
  contentType: string,
) {
  const file = bucket.file(key);
  try {
    await file.save(bytes, {
      contentType,
      resumable: false,
      metadata: { cacheControl: 'private,no-store' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (error) {
    if (!hasCode(error, 412)) throw error;
  }
  const [metadata] = await file.getMetadata();
  if (!metadata.generation || Number(metadata.size) !== bytes.length) {
    throw new PremiumBookError(
      502,
      'premium_asset_integrity',
      'Premium object verification failed',
    );
  }
  const asset = {
    key,
    generation: String(metadata.generation),
    bytes: bytes.length,
    sha256: premiumDigest(bytes),
  };
  await readPremiumObject(bucket, asset);
  return asset;
}

export function savePremiumImage(
  bucket: Bucket,
  prefix: string,
  bytes: Buffer,
  ext: 'jpg' | 'png',
) {
  return savePremiumObject(
    bucket,
    `${prefix}/assets/${premiumDigest(bytes)}.${ext}`,
    bytes,
    ext === 'png' ? 'image/png' : 'image/jpeg',
  );
}

export async function readPremiumObject(bucket: Bucket, asset: PremiumAsset) {
  // The Storage SDK converts the generation to a Number when constructing a File.
  const generation = Number(asset.generation);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    String(generation) !== asset.generation
  ) {
    throw new PremiumBookError(
      409,
      'premium_asset_generation',
      'Cannot address this exact premium object generation',
    );
  }
  let bytes: Buffer;
  try {
    [bytes] = await bucket.file(asset.key, { generation: asset.generation }).download();
  } catch (error) {
    if (hasCode(error, 404)) {
      throw new PremiumBookError(
        409,
        'premium_asset_missing',
        'Required premium object is missing',
      );
    }
    if (hasCode(error, 403)) {
      throw new PremiumBookError(
        409,
        'premium_asset_denied',
        'Required premium object is inaccessible',
      );
    }
    throw error;
  }
  if (bytes.length !== asset.bytes || premiumDigest(bytes) !== asset.sha256) {
    throw new PremiumBookError(
      409,
      'premium_asset_integrity',
      'Premium object integrity check failed',
    );
  }
  return bytes;
}

export function verifyPremiumAssetScope(storyId: string, asset: PremiumAsset) {
  const prefix = `${storyId}/premium/revisions/`;
  const match = /^([0-9a-f-]{36})\/assets\/([0-9a-f]{64})\.(jpg|png)$/u.exec(
    asset.key.slice(prefix.length),
  );
  if (
    !asset.key.startsWith(prefix) ||
    !z.uuid().safeParse(match?.[1]).success ||
    match?.[2] !== asset.sha256
  ) {
    throw new PremiumBookError(
      409,
      'premium_asset_scope',
      'Premium object belongs to a different book',
    );
  }
}

export async function readPremiumManifest(
  bucket: Bucket,
  storyId: string,
  ownerId: string,
  revision: string,
  asset: PremiumAsset,
): Promise<PremiumManifest> {
  if (asset.key !== `${premiumRevisionPrefix(storyId, revision)}/manifest.json`) {
    throw new PremiumBookError(
      409,
      'premium_manifest_key',
      'Premium manifest key does not match its revision',
    );
  }
  const bytes = await readPremiumObject(bucket, asset);
  const value = decodePremiumDocument(bytes, premiumManifest);
  if (value.storyId !== storyId || value.ownerId !== ownerId || value.revision !== revision) {
    throw new PremiumBookError(
      409,
      'premium_manifest_identity',
      'Premium manifest identity does not match',
    );
  }
  return value;
}

function decodePremiumDocument<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new PremiumBookError(
      409,
      'premium_document_invalid',
      'Invalid or mismatched premium document',
    );
  }
}

export async function readPremiumCheckpoint<T>(bucket: Bucket, key: string, schema: z.ZodType<T>) {
  try {
    const [bytes] = await bucket.file(key).download();
    return decodePremiumDocument(bytes, schema);
  } catch (error) {
    if (hasCode(error, 404)) return undefined;
    throw error;
  }
}

export async function stagePremiumCheckpoint<T>(
  bucket: Bucket,
  key: string,
  schema: z.ZodType<T>,
  make: () => Promise<T>,
): Promise<T> {
  const prior = await readPremiumCheckpoint(bucket, key, schema);
  if (prior !== undefined) return prior;
  const value = schema.parse(await make());
  try {
    await bucket.file(key).save(JSON.stringify(value), {
      contentType: 'application/json',
      resumable: false,
      metadata: { cacheControl: 'private,no-store' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return value;
  } catch (error) {
    if (!hasCode(error, 412)) throw error;
    const winner = await readPremiumCheckpoint(bucket, key, schema);
    if (!winner) throw error;
    return winner;
  }
}

// There is one active provider attempt for a stage. A killed process leaves a lease
// until it expires, and generation-matched cleanup cannot remove a successor's lease.
export async function withPremiumLease<T>(bucket: Bucket, key: string, action: () => Promise<T>) {
  const lock = bucket.file(`${key}.lock`);
  let expected = '0';
  try {
    const [metadata] = await lock.getMetadata();
    if (
      !metadata.generation ||
      !metadata.updated ||
      Date.now() - Date.parse(metadata.updated) < 10 * 60_000
    ) {
      throw new PremiumBookError(503, 'premium_stage_busy', 'Premium stage is already in progress');
    }
    expected = String(metadata.generation);
  } catch (error) {
    if (!hasCode(error, 404)) throw error;
  }
  const token = randomUUID();
  try {
    await lock.save(token, {
      preconditionOpts: { ifGenerationMatch: expected },
      resumable: false,
      metadata: { cacheControl: 'private,no-store', metadata: { token } },
    });
  } catch (error) {
    if (!hasCode(error, 412)) throw error;
    throw new PremiumBookError(503, 'premium_stage_busy', 'Premium stage is already in progress');
  }
  const [metadata] = await lock.getMetadata();
  if (!metadata.generation || metadata.metadata?.token !== token) {
    throw new PremiumBookError(503, 'premium_stage_busy', 'Premium stage lease was superseded');
  }
  try {
    return await action();
  } finally {
    try {
      await lock.delete({ ifGenerationMatch: metadata.generation });
    } catch {
      // Lease expiry covers cleanup after an interrupted request or storage fault.
    }
  }
}
