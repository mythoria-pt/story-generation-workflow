import sharp from 'sharp';
import { PremiumBookError } from './premium-book-contract.js';

// Both densities are divisible by eight, so 1/8-inch bleed and the join land on integer pixels.
export const PREMIUM_PRINT_PPI = 304;
export const PREMIUM_READING_PPI = 96;
const TRIM_INCHES = 8.5;
const BLEED_INCHES = 0.125;
type Crop = { x: number; y: number; width: number; height: number };

export function premiumGeometry(ppi: number, facing: boolean) {
  const bleed = ppi * BLEED_INCHES;
  const trim = ppi * TRIM_INCHES;
  if (!Number.isInteger(bleed) || !Number.isInteger(trim)) {
    throw new Error('Premium geometry needs an integer pixel grid');
  }
  const width = trim * (facing ? 2 : 1) + 2 * bleed;
  const height = trim + 2 * bleed;
  return {
    width,
    height,
    reading: [
      { x: bleed, y: bleed, width: trim, height: trim },
      ...(facing ? [{ x: bleed + trim, y: bleed, width: trim, height: trim }] : []),
    ],
    print: [
      { x: 0, y: 0, width: height, height },
      ...(facing ? [{ x: trim, y: 0, width: height, height }] : []),
    ],
  };
}

const getCrop = ({ x, y, width, height }: Crop) => ({ left: x, top: y, width, height });

export async function hasPremiumCentreLine(source: Buffer): Promise<boolean> {
  const { data, info } = await sharp(source, { limitInputPixels: 16_000_000, failOn: 'warning' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const middle = Math.floor(width / 2);
  const scale = width / 3840;
  const sampleDistance = Math.max(1, Math.round(2 * scale));
  const bandCount = 10;
  const profile = (x: number) => {
    const contrasts = new Array<number>(bandCount).fill(0);
    const totals = new Array<number>(bandCount).fill(0);
    for (let y = 0; y < height; y += Math.max(1, Math.round(3 * scale))) {
      const band = Math.floor((y * bandCount) / height);
      const left = (y * width + x - sampleDistance) * channels;
      const right = (y * width + x + sampleDistance) * channels;
      const contrast =
        Math.abs((data[left] ?? 0) - (data[right] ?? 0)) +
        Math.abs((data[left + 1] ?? 0) - (data[right + 1] ?? 0)) +
        Math.abs((data[left + 2] ?? 0) - (data[right + 2] ?? 0));
      if (contrast > 48) contrasts[band] = (contrasts[band] ?? 0) + 1;
      totals[band] = (totals[band] ?? 0) + 1;
    }
    return contrasts.map((count, band) => count / (totals[band] || 1));
  };
  const nearby = [-64, -56, -48, -40, -32, -24, -16, 16, 24, 32, 40, 48, 56, 64].map((offset) =>
    profile(middle + Math.round(offset * scale)),
  );
  const typical = Array.from(
    { length: bandCount },
    (_, band) =>
      nearby.map((column) => column[band] ?? 0).sort((a, b) => a - b)[
        Math.floor(nearby.length / 2)
      ] ?? 0,
  );
  const scan = Math.max(2, Math.round(8 * scale));
  for (let offset = -scan; offset <= scan; offset++) {
    // A line must extend through multiple horizontal bands and beat the surrounding
    // image's texture in those same bands. A single object edge can occupy one band.
    const persistentBands = profile(middle + offset).filter(
      (value, band) => value >= 0.64 && value - (typical[band] ?? 0) >= 0.28,
    );
    if (persistentBands.length >= 3) return true;
  }
  return false;
}

export async function exportPremiumArtwork(source: Buffer, size: string, facing: boolean) {
  const input = sharp(source, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const info = await input.metadata();
  if (
    !info.width ||
    !info.height ||
    `${info.width}x${info.height}` !== size ||
    info.hasAlpha ||
    (info.pages ?? 1) !== 1 ||
    info.format !== 'png'
  ) {
    throw new PremiumBookError(
      502,
      'premium_image_dimensions',
      'Unexpected premium image dimensions',
    );
  }
  if (facing && (await hasPremiumCentreLine(source))) {
    throw new PremiumBookError(
      502,
      'premium_image_join',
      'Premium artwork has a visible centre line',
    );
  }
  const print = premiumGeometry(PREMIUM_PRINT_PPI, facing);
  const digital = premiumGeometry(PREMIUM_READING_PPI, facing);
  const centered = (width: number, height: number) =>
    input.clone().resize(width, height, { fit: 'cover', position: 'centre' }).toColourspace('srgb');
  const pixels = await centered(print.width, print.height).png().toBuffer();
  const readingMaster = await centered(digital.width, digital.height).png().toBuffer();
  const printPages: Buffer[] = [];
  const readingPages: Buffer[] = [];
  for (const crop of print.print) {
    printPages.push(
      await sharp(pixels)
        .extract(getCrop(crop))
        .jpeg({
          quality: 95,
          chromaSubsampling: '4:4:4',
        })
        .toBuffer(),
    );
  }
  for (const crop of digital.reading) {
    readingPages.push(await sharp(readingMaster).extract(getCrop(crop)).png().toBuffer());
  }
  return {
    printPages,
    readingPages,
    readingMaster,
    nativeWidth: info.width,
    nativeHeight: info.height,
    effectivePpi: Math.min(info.width / (facing ? 17.25 : 8.75), info.height / 8.75),
    digitalCrops: digital.reading,
    printCrops: print.print,
  };
}
