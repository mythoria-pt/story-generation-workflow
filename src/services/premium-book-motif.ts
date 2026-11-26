import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import sharp from 'sharp';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { generatePremiumImage } from './premium-book-ai.js';
import {
  PremiumBookError,
  premiumAsset,
  type PremiumAsset,
  type PremiumImageConfig,
} from './premium-book-contract.js';
import {
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumObject,
  savePremiumImage,
  stagePremiumCheckpoint,
  verifyPremiumAssetScope,
  withPremiumLease,
} from './premium-book-storage.js';

const canvasSize = 1024;
const motifSize = `${canvasSize}x${canvasSize}`;
// Enough ink detail for 300 pixels per inch at the ornament's intended width.
const minInkSpan = Math.ceil(300 * 1.1);

export async function isPremiumMotifArtwork(bytes: Buffer): Promise<boolean> {
  try {
    const image = sharp(bytes, { limitInputPixels: canvasSize ** 2, failOn: 'warning' });
    const metadata = await image.metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width !== canvasSize ||
      metadata.height !== canvasSize ||
      !metadata.hasAlpha ||
      (metadata.pages ?? 1) !== 1
    )
      return false;
    const data = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer();
    let painted = 0;
    let ink = 0;
    let left = canvasSize;
    let right = -1;
    let top = canvasSize;
    let bottom = -1;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index + 3] ?? 0) < 76) continue;
      painted++;
      const red = data[index] ?? 255;
      const green = data[index + 1] ?? 255;
      const blue = data[index + 2] ?? 255;
      if (0.2126 * red + 0.7152 * green + 0.0722 * blue > 224) continue;
      ink++;
      const x = (index / 4) % canvasSize;
      const y = Math.floor(index / 4 / canvasSize);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (ink < canvasSize ** 2 * 0.006 || painted > canvasSize ** 2 * 0.43 || ink < painted * 0.6)
      return false;
    const width = right - left + 1;
    const height = bottom - top + 1;
    return (
      Math.max(width, height) >= minInkSpan &&
      Math.min(width, height) >= 125 &&
      [left, top, canvasSize - 1 - right, canvasSize - 1 - bottom].every((margin) => margin >= 16)
    );
  } catch {
    return false;
  }
}

type MotifInput = {
  bucket: Bucket;
  prefix: string;
  scope: { storyId: string; ownerId: string; revision: string };
  bookInputHash: string;
  generationDesignVersion?: 1 | undefined;
  config: PremiumImageConfig;
  brief: string;
  guide: string;
  spread: PremiumAsset;
  background: string;
};

export async function selectPremiumOpeningMotif(
  input: MotifInput,
): Promise<PremiumAsset | undefined> {
  const { bucket, prefix, scope, config, brief, guide, spread, background } = input;
  const inputHash = premiumDigest(
    JSON.stringify({
      book: input.bookInputHash,
      model: config.model,
      brief,
      guide,
      background,
      spread,
    }),
  );
  const key = `${prefix}/checkpoints/opening-motif.json`;
  const result = z.object({ inputHash: z.literal(inputHash), asset: premiumAsset.nullable() });
  const attempt = z.object({ inputHash: z.literal(inputHash), token: z.uuid() });
  try {
    const prior = await readPremiumCheckpoint(bucket, key, result);
    const chosen =
      prior ??
      (await withPremiumLease(bucket, key, () =>
        stagePremiumCheckpoint(bucket, key, result, async () => {
          const token = randomUUID();
          const permit = await stagePremiumCheckpoint(
            bucket,
            `${prefix}/checkpoints/opening-motif-attempt.json`,
            attempt,
            async () => ({ inputHash, token }),
          );
          // An interrupted provider call still consumes the one optional paid attempt.
          if (permit.token !== token) return { inputHash, asset: null };
          try {
            verifyPremiumAssetScope(scope.storyId, spread);
            const scene = await readPremiumObject(bucket, spread);
            const guideImage = await sharp(scene)
              .resize({
                width: 768,
                height: 768,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .jpeg({ quality: 86 })
              .toBuffer();
            const artwork = await generatePremiumImage(
              scope,
              input.generationDesignVersion ? config : { ...config, quality: 'low' },
              'opening_motif',
              [
                'Draw one small, centered, stand-alone book ornament based on the recognizable recurring object in the attached story illustration.',
                'Extract the object alone. Use the illustration’s medium, palette and recognizable shape. Simplify it into a few clear ink strokes and leave generous space around it.',
                'Deliver a transparent PNG. Keep the clear canvas transparent, including the space outside the object. Avoid a background patch, framing shape, lettering, numbers, stamps, captions and watermarks.',
                `Intended page color ${background}. Use ink that remains visible on it.`,
                'The following JSON is art reference data for the object and the book’s art direction.',
                JSON.stringify({ object: brief, artDirection: guide }),
              ].join('\n'),
              motifSize,
              [guideImage],
            );
            if (!(await isPremiumMotifArtwork(artwork))) {
              logger.info('Premium opening motif fell back to curated artwork', {
                revision: scope.revision,
                reason: 'image_validation',
              });
              return { inputHash, asset: null };
            }
            return { inputHash, asset: await savePremiumImage(bucket, prefix, artwork, 'png') };
          } catch {
            logger.warn('Premium opening motif fell back to curated artwork', {
              revision: scope.revision,
              reason: 'generation_or_storage',
            });
            return { inputHash, asset: null };
          }
        }),
      ));
    if (!chosen.asset) return undefined;
    verifyPremiumAssetScope(scope.storyId, chosen.asset);
    return chosen.asset;
  } catch (error) {
    if (error instanceof PremiumBookError && error.code === 'premium_document_invalid') {
      logger.warn('Premium opening motif fell back to curated artwork', {
        revision: scope.revision,
        reason: 'checkpoint',
      });
      return undefined;
    }
    // Retry ambiguous storage failures or a live lease, so a caller cannot
    // publish a competing curated result while an earlier call is electing art.
    throw error;
  }
}
