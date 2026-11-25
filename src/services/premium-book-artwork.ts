import sharp from 'sharp';
import {
  PREMIUM_PRINT_PPI,
  PREMIUM_TEXT_BOX,
  PremiumBookError,
  type PremiumTextBox,
  type PremiumTextLayout,
} from './premium-book-contract.js';

// Both densities are divisible by eight, so 1/8-inch bleed and the join land on integer pixels.
export { PREMIUM_PRINT_PPI };
export const PREMIUM_READING_PPI = 96;
export const PREMIUM_NATIVE_PAGE_SIZE = '2672x2672';
const TRIM_INCHES = 8.5;
const BLEED_INCHES = 0.125;
type Crop = { x: number; y: number; width: number; height: number };
export type PremiumSpreadReviewAreas = { textAreas: Crop[]; gutter: Crop };
export type PremiumSpreadTextBoxes = { left?: PremiumTextBox | undefined; right: PremiumTextBox };

export function defaultPremiumSpreadTextBoxes(
  textLayout?: PremiumTextLayout,
): PremiumSpreadTextBoxes {
  return {
    ...(textLayout !== 'right_only' && { left: PREMIUM_TEXT_BOX }),
    right: PREMIUM_TEXT_BOX,
  };
}

export function lowerPremiumSpreadTextBoxes({
  left,
  right,
}: PremiumSpreadTextBoxes): PremiumSpreadTextBoxes {
  const lower = (box: PremiumTextBox) => ({
    ...box,
    y: Math.max(box.y, Number((1 - box.y - box.height).toFixed(6))),
  });
  return { ...(left && { left: lower(left) }), right: lower(right) };
}

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

export function premiumSpreadComposition(
  textLayout?: PremiumTextLayout,
  boxes = defaultPremiumSpreadTextBoxes(textLayout),
) {
  const rightOnly = textLayout === 'right_only';
  const geometry = premiumGeometry(PREMIUM_READING_PPI, true);
  const textAreas = geometry.reading.flatMap((page, index) => {
    const box = index === 0 ? boxes.left : boxes.right;
    if (!box) return [];
    const { x, y, width, height } = box;
    return [
      {
        x: (page.x + page.width * x) / geometry.width,
        y: (page.y + page.height * y) / geometry.height,
        width: (page.width * width) / geometry.width,
        height: (page.height * height) / geometry.height,
      },
    ];
  });
  const gutter = { x: 0.45, y: 0, width: 0.1, height: 1 };
  const percent = (value: number) => (100 * value).toFixed(1);
  const textAreaDescriptions = textAreas.map(({ x, y, width, height }) => {
    const left = percent(x);
    const right = percent(x + width);
    const top = percent(y);
    const bottom = percent(y + height);
    return `from ${left}% to ${right}% across and ${top}% to ${bottom}% down`;
  });
  const rightPanelUpper = boxes.right.y < 0.5;
  const canUseDefaultStaging = rightPanelUpper && (!boxes.left || boxes.left.y < 0.5);
  const placement = canUseDefaultStaging
    ? rightOnly
      ? 'Leave the upper part of the right half as unobtrusive scenery and keep the entire important right-hand subject below it.'
      : 'Leave the upper part of both halves as unobtrusive scenery. Place the main action and faces in the lower part of the painting, comfortably separated from the centre.'
    : [boxes.left, boxes.right]
        .flatMap((box, index) =>
          box
            ? [
                `On the ${index === 0 ? 'left' : 'right'} half, use the ${box.y < 0.5 ? 'upper' : 'lower'} area for unobtrusive scenery and leave that area clear of important subjects.`,
              ]
            : [],
        )
        .join(' ');
  return {
    reviewAreas: { textAreas, gutter } satisfies PremiumSpreadReviewAreas,
    generation: [
      'Paint one uninterrupted edge-to-edge panorama of a single moment with a continuous background across the middle. Keep faces, important gestures and story-critical objects well clear of the centre and outer edges.',
      placement,
      ...(rightOnly
        ? [
            'Use the upper left for story details. Keep every essential subject and prop from the left-page description recognizable when the left page is viewed by itself. A prop can continue to the right if enough of it is visible on the left to support the description.',
          ]
        : []),
      'Anchor the main character on one half and keep the people and gestures involved in that action together. The other half can hold a secondary group, action or prop. Scenery and incidental parts of a prop, such as a mirror frame, may cross the centre. Keep each important face, reflected face, gesture and story clue fully on one half and comfortably clear of the binding.',
      `When a close-up would bring faces, expressions or important objects into the binding area or a text area, pull the camera back. Keep the expression or clue clear in the smaller framing and place the full important right-hand subject ${rightPanelUpper ? 'below' : 'above'} the right-hand text area.`,
      'If the scene describes successive actions, choose one clear instant that conveys the central event. Show each character once, except for a natural reflection. Preserve the visual clue and the character likeness. Keep the artwork free of lettering, panels, borders, folds and visible guides.',
    ].join(' '),
    review: [
      'This is one continuous full-bleed panorama. Ordinary scenery may cross the centre and run off the outer edges. Keep faces, important gestures and story-critical objects outside the gutter band from 45% to 55% across the full canvas and safely inside the outer trim.',
      `An opaque typeset panel may cover the marked text areas. Measured from the upper-left of the full image including bleed, the areas are ${textAreaDescriptions.join(' and ')}. Keep faces, important gestures and story-critical objects clear of the panels. Ordinary background scenery and texture in these areas are fine.`,
      ...(rightOnly ? ['The left half has no text panel.'] : []),
    ].join(' '),
  };
}

export function createPremiumSpreadScaffold(
  size: string,
  textLayout?: PremiumTextLayout,
  boxes = defaultPremiumSpreadTextBoxes(textLayout),
) {
  const geometry = premiumGeometry(PREMIUM_READING_PPI, true);
  const [width, height] = size.split('x').map(Number);
  const clusterShapes = geometry.reading.map((page, index) => {
    const box = index === 0 ? boxes.left : boxes.right;
    const isUpper = box && box.y < 0.5;
    const top = isUpper ? box.y + box.height + 0.09 : 0.15;
    const bottom = box && !isUpper ? box.y - 0.09 : 0.88;
    const cx = (page.x + page.width * 0.5) / geometry.width;
    const cy = (page.y + page.height * (top + bottom) * 0.5) / geometry.height;
    const rx = (page.width * 0.32) / geometry.width;
    const ry = (page.height * (bottom - top) * 0.5) / geometry.height;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#cluster)"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1 1" preserveAspectRatio="none"><defs><radialGradient id="cluster"><stop stop-color="#8c8c8c"/><stop offset="1" stop-color="#ededed"/></radialGradient></defs><rect width="1" height="1" fill="#ededed"/>${clusterShapes.join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 84 }).toBuffer();
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

export async function inspectPremiumOpaquePng(source: Buffer, size: string) {
  const image = sharp(source, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const info = await image.metadata();
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
  return { image, width: info.width, height: info.height };
}

export async function exportPremiumArtwork(
  source: Buffer,
  size: string,
  facing: boolean,
  requireNative = false,
) {
  const {
    image: input,
    width: nativeWidth,
    height: nativeHeight,
  } = await inspectPremiumOpaquePng(source, size);
  const print = premiumGeometry(PREMIUM_PRINT_PPI, facing);
  const effectivePpi = Math.min(
    (nativeWidth / print.width) * PREMIUM_PRINT_PPI,
    (nativeHeight / print.height) * PREMIUM_PRINT_PPI,
  );
  if (requireNative && effectivePpi < PREMIUM_PRINT_PPI) {
    throw new PremiumBookError(
      502,
      'premium_native_print_resolution',
      'Premium artwork lacks enough native pixels for its full-bleed print size',
    );
  }
  if (facing && (await hasPremiumCentreLine(source))) {
    throw new PremiumBookError(
      502,
      'premium_image_join',
      'Premium artwork has a visible centre line',
    );
  }
  const digital = premiumGeometry(PREMIUM_READING_PPI, facing);
  const centered = (width: number, height: number) =>
    input
      .clone()
      .resize(width, height, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: requireNative,
      })
      .toColourspace('srgb');
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
    nativeWidth,
    nativeHeight,
    effectivePpi,
    digitalCrops: digital.reading,
    printCrops: print.print,
  };
}

export async function createPremiumNativeSpreadGuides(panorama: Buffer): Promise<[Buffer, Buffer]> {
  const geometry = premiumGeometry(PREMIUM_READING_PPI, true);
  // Guides are deliberately smaller than the new paint output. Match the production
  // bleed framing so the page renders share the same piece of scenery at the binding.
  const draft = await sharp(panorama, { limitInputPixels: 16_000_000 })
    .resize(geometry.width, geometry.height, { fit: 'cover', position: 'centre' })
    .toColourspace('srgb')
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const [left, right] = geometry.print;
  if (!left || !right) throw new Error('Missing native spread guide crop');
  const crop = (area: Crop) =>
    sharp(draft)
      .extract(getCrop(area))
      .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
      .toBuffer();
  return Promise.all([crop(left), crop(right)]);
}

export async function exportNativePremiumSpread(left: Buffer, right: Buffer) {
  const { width, height, print } = premiumGeometry(PREMIUM_PRINT_PPI, true);
  const [leftPage, rightPage] = print;
  if (!leftPage || !rightPage) throw new Error('Missing native spread print crop');
  const channels = 3;
  const pagePixels = async (source: Buffer) => {
    const { image, width: sourceWidth } = await inspectPremiumOpaquePng(
      source,
      PREMIUM_NATIVE_PAGE_SIZE,
    ).catch(() => {
      throw new PremiumBookError(
        502,
        'premium_native_print_resolution',
        'Premium spread requires two native-resolution, opaque page images',
      );
    });
    const margin = Math.floor((sourceWidth - height) / 2);
    return image
      .extract({ left: margin, top: margin, width: height, height })
      .toColourspace('srgb')
      .raw()
      .toBuffer();
  };
  const [leftPixels, rightPixels] = await Promise.all([pagePixels(left), pagePixels(right)]);
  const pixels = Buffer.alloc(width * height * channels);
  const overlap = leftPage.width - rightPage.x;
  for (let y = 0; y < height; y++) {
    const row = y * height * channels;
    const target = y * width * channels;
    const rightOffset = target + rightPage.x * channels;
    leftPixels.copy(pixels, target, row, row + leftPage.width * channels);
    rightPixels.copy(
      pixels,
      rightOffset + overlap * channels,
      row + overlap * channels,
      row + height * channels,
    );
    for (let x = 0; x < overlap; x++) {
      const weight = x / (overlap - 1);
      for (let channel = 0; channel < channels; channel++) {
        const index = x * channels + channel;
        pixels[rightOffset + index] = Math.round(
          (pixels[rightOffset + index] ?? 0) * (1 - weight) +
            (rightPixels[row + index] ?? 0) * weight,
        );
      }
    }
  }
  // Every pixel outside the shared binding overlap comes from its original page
  // render at its original scale. The same overlap is used by both print crops.
  const source = await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
  return { source, ...(await exportPremiumArtwork(source, `${width}x${height}`, true, true)) };
}
