import { premiumManifestFixture } from './fixtures/premium-book.js';
import { readPremiumObject } from '@/services/premium-book-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import { describe, expect, it } from '@jest/globals';
import { OrderProofRequest } from '@/services/order-proof.js';
import {
  assertSquareCasewrap,
  squarePackage,
  validatePremiumManifest,
} from '@/services/premium-order-proof.js';

const storyId = randomUUID(),
  revision = randomUUID();
const path = storyId + '/premium/revisions/' + revision;
const digest = createHash('sha256').update('hello').digest('hex');
const image = {
  key: path + '/assets/' + digest + '.jpg',
  generation: '10',
  sha256: digest,
  bytes: 5,
};
const pin = {
  version: 1,
  type: 'premium_children',
  state: 'published',
  revision,
  manifest: { ...image, key: path + '/manifest.json' },
};
const input = {
  storyId,
  runId: randomUUID(),
  orderId: randomUUID(),
  provider: 'lulu',
  binding: 'hardcover',
  podPackageId: squarePackage,
  premiumBook: pin,
};
const manifest = premiumManifestFixture();
describe('square order proof', () => {
  it('requires the pinned revision, exact product, and Lulu hardcover', () => {
    expect(OrderProofRequest.parse(input)).toMatchObject(input);
    for (const fields of [
      { binding: 'paperback' },
      { provider: 'manual' },
      { premiumBook: undefined },
      { podPackageId: undefined },
      { storyId: randomUUID() },
      { premiumBook: { ...pin, state: 'draft' } },
    ]) {
      expect(OrderProofRequest.safeParse({ ...input, ...fields }).success).toBe(false);
    }
  });
  it('accepts a complete ordered edition, detects cross-story artwork, missing pages and broken pairs', () => {
    expect(
      validatePremiumManifest(manifest, manifest.storyId, manifest.revision).pages,
    ).toHaveLength(32);
    for (const fields of [
      { pages: manifest.pages.slice(1) },
      { revision: randomUUID() },
      { covers: { front: image, back: { ...image, key: 'another-story/photo.jpg' } } },
      { spreads: manifest.spreads.toReversed() },
      { pages: manifest.pages.map((p, i) => (i === 8 ? { ...p, artwork: undefined } : p)) },
    ])
      expect(() =>
        validatePremiumManifest({ ...manifest, ...fields }, manifest.storyId, manifest.revision),
      ).toThrow();
    expect(() => assertSquareCasewrap({ width: 1368, height: 738 })).not.toThrow();
    expect(() => assertSquareCasewrap({ width: 1100, height: 738 })).toThrow();
  });
  it('downloads the exact storage generation and rejects changed bytes', async () => {
    const bucket = {
      file: (key: string, { generation }: { generation: string }) => {
        expect(key).toBe(image.key);
        expect(generation).toBe('10');
        return {
          getMetadata: async () => [{ size: '5', generation: '10' }],
          download: async () => [Buffer.from('hello')],
        };
      },
    } as unknown as Bucket;
    expect(await readPremiumObject(bucket, image)).toEqual(Buffer.from('hello'));
    await expect(
      readPremiumObject(bucket, { ...image, generation: '9007199254740993' }),
    ).rejects.toThrow('exact premium object generation');
    await expect(readPremiumObject(bucket, { ...image, sha256: '0'.repeat(64) })).rejects.toThrow(
      'integrity',
    );
  });
});
