/**
 * Image processing utilities (backed by `sharp`).
 *
 * Used to:
 *  - normalise user-uploaded input images to a storage-friendly JPEG
 *    (max 2048px on the longest side, 95% quality, EXIF orientation baked in)
 *  - crop a detected character (person/animal) out of a normalised photo using
 *    the bounding box returned by the image-analysis model.
 */

import sharp from 'sharp';
import { logger } from '@/config/logger.js';

export interface NormalizedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Gemini bounding box, normalised to a 0–1000 grid in `[ymin, xmin, ymax, xmax]`
 * order (the format returned by the Gemini object-detection prompt).
 */
export type Box2d = [number, number, number, number];

const DEFAULT_MAX_DIM = 2048;
const DEFAULT_QUALITY = 95;

/**
 * Re-encode an arbitrary image buffer to a normalised JPEG: auto-oriented from
 * EXIF, scaled so the longest side is at most `maxDim` (never upscaled), encoded
 * at `quality`. Orientation is baked in and EXIF stripped, so coordinates derived
 * from the returned bytes are stable for later cropping.
 */
export async function normalizeToJpeg(
  input: Buffer,
  opts?: { maxDim?: number; quality?: number },
): Promise<NormalizedImage> {
  const maxDim = opts?.maxDim ?? DEFAULT_MAX_DIM;
  const quality = opts?.quality ?? DEFAULT_QUALITY;

  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate() // auto-orient using EXIF, then the tag is dropped on re-encode
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Crop a region from a normalised JPEG using a Gemini `box_2d`
 * (`[ymin, xmin, ymax, xmax]`, 0–1000). `padding` expands the box by a fraction
 * of its own size on every edge (default 8%) to avoid clipping faces/bodies.
 *
 * The input is expected to be an already-normalised JPEG (no EXIF orientation),
 * so the stored dimensions match what the analysis model saw.
 */
export async function cropToJpeg(
  input: Buffer,
  box: Box2d,
  opts?: { padding?: number; quality?: number },
): Promise<Buffer> {
  const quality = opts?.quality ?? DEFAULT_QUALITY;
  const padding = opts?.padding ?? 0.08;

  const image = sharp(input, { failOn: 'none' });
  const meta = await image.metadata();
  const imgW = meta.width;
  const imgH = meta.height;
  if (!imgW || !imgH) {
    throw new Error('Unable to read image dimensions for cropping');
  }

  const [ymin, xmin, ymax, xmax] = box;

  // Normalised (0–1000) -> pixels
  let left = (xmin / 1000) * imgW;
  let top = (ymin / 1000) * imgH;
  let right = (xmax / 1000) * imgW;
  let bottom = (ymax / 1000) * imgH;

  // Guard against models emitting reversed coordinates
  if (right < left) [left, right] = [right, left];
  if (bottom < top) [top, bottom] = [bottom, top];

  // Pad by a fraction of the box size
  const padX = (right - left) * padding;
  const padY = (bottom - top) * padding;
  left -= padX;
  right += padX;
  top -= padY;
  bottom += padY;

  // Clamp to image bounds
  left = Math.max(0, Math.floor(left));
  top = Math.max(0, Math.floor(top));
  right = Math.min(imgW, Math.ceil(right));
  bottom = Math.min(imgH, Math.ceil(bottom));

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  logger.debug('Cropping character from photo', { imgW, imgH, left, top, width, height, box });

  return sharp(input, { failOn: 'none' })
    .extract({ left, top, width, height })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}
