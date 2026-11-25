import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

export type Binding = 'paperback' | 'hardcover';
export const luluInterior = { width: 437.528, height: 613.276 };
const hardcoverBands = [
  84, 140, 168, 194, 222, 250, 278, 306, 334, 360, 388, 416, 444, 472, 500, 528, 556, 582, 610, 638,
  666, 694, 722, 750, 778, 799, 800,
];

export function luluSpinePoints(binding: Binding, count: number, coverWidth: number) {
  const minimum = binding === 'paperback' ? 32 : 24;
  if (!Number.isInteger(count) || count < minimum || count > 800) {
    throw new Error('Lulu page count outside package limits');
  }
  if (binding === 'paperback') {
    // Remove the two trim panels and outer bleeds from the supplier's canvas.
    const spine = coverWidth - 2 * (luluInterior.width - 18) - 18;
    if (Math.abs(spine - 72 * (count / 444 + 0.06)) > 2)
      throw new Error('Unexpected A5 paperback cover dimensions');
    return spine;
  }
  const index = hardcoverBands.findIndex((limit) => count <= limit);
  const spine = (index === 0 ? 0.25 : index === 1 ? 0.5 : 0.625 + (index - 2) / 16) * 72;
  if (coverWidth < 2 * (luluInterior.width - 18) + 108 + spine)
    throw new Error('Unexpected casewrap cover dimensions');
  return spine;
}

export async function finishLuluPdf(
  bytes: Uint8Array,
  dimensions: { width: number; height: number },
  interior: boolean,
  profile: Uint8Array,
) {
  const doc = await PDFDocument.load(bytes);
  if (!interior && doc.getPageCount() !== 1) throw new Error('Cover must contain one spread');
  const stream = doc.context.flateStream(profile, { N: 3, Alternate: 'DeviceRGB' });
  const icc = doc.context.register(stream);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // Chromium rounds CSS sizes to printer pixels. Reject materially different canvases.
    if (Math.abs(width - dimensions.width) > 1.2 || Math.abs(height - dimensions.height) > 1.2)
      throw new Error('Incorrect Lulu page geometry');
    page.setMediaBox(0, 0, dimensions.width, dimensions.height);
    page.setCropBox(0, 0, dimensions.width, dimensions.height);
    page.setBleedBox(0, 0, dimensions.width, dimensions.height);
    if (interior) page.setTrimBox(9, 9, dimensions.width - 18, dimensions.height - 18);
    const resources = page.node.normalizedEntries().Resources;
    let colors = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
    if (!colors) {
      colors = doc.context.obj({});
      resources.set(PDFName.of('ColorSpace'), colors);
    }
    colors.set(PDFName.of('DefaultRGB'), doc.context.obj(['ICCBased', icc]));
  }
  return Buffer.from(await doc.save());
}

export function loadSrgbProfile() {
  const path =
    process.platform === 'win32'
      ? join(
          process.env.SystemRoot || 'C:/Windows',
          'System32/spool/drivers/color/sRGB Color Space Profile.icm',
        )
      : '/usr/share/color/icc/sRGB.icc';
  return readFile(path);
}

const run = promisify(execFile);
export async function inspectLuluAssets(path: string) {
  const options = { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const [fonts, images] = await Promise.all([
    run('pdffonts', [path], options),
    run('pdfimages', ['-list', path], options),
  ]);
  const fontRows = fonts.stdout.trimEnd().split(/\r?\n/).slice(2);
  const imageRows = images.stdout.trimEnd().split(/\r?\n/).slice(2);
  const unembedded = fontRows.some(
    (row) => !/\s+yes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/.test(row),
  );
  const lowResolution = imageRows.some((row) => {
    const cells = row.trim().split(/\s+/);
    return cells[2] === 'image' && (Number(cells[12]) < 300 || Number(cells[13]) < 300);
  });
  return [
    ...(unembedded ? ['unembedded_font'] : []),
    ...(lowResolution ? ['image_below_300_ppi'] : []),
  ];
}
