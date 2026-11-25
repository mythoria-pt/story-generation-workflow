import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { exportPremiumArtwork } from '../src/services/premium-book-artwork.js';

// This local excerpt uses the same bleed, gutter and trim crops as a full edition.
// The artwork already contains the lettering. No text renderer runs on these pages.
async function main() {
  const [source, directory, specification] = process.argv.slice(2);
  if (!source || !directory) {
    throw new Error(
      'Usage: tsx scripts/preview-lettered-spread.ts panorama.png output-dir [spec.pdf]',
    );
  }
  const bytes = await readFile(source);
  const { width, height } = await sharp(bytes).metadata();
  const art = await exportPremiumArtwork(bytes, `${width}x${height}`, true);
  const excerpt = await PDFDocument.create();
  if (specification) {
    const spec = await PDFDocument.load(await readFile(specification));
    if (spec.getPageCount() !== 1) throw new Error('Expected a single specification page.');
    const [page] = await excerpt.copyPages(spec, [0]);
    excerpt.addPage(page);
  }
  for (const [index, side] of ['left', 'right'].entries()) {
    const image = await excerpt.embedJpg(art.printPages[index]!);
    const page = excerpt.addPage([630, 630]);
    page.setTrimBox(9, 9, 612, 612);
    page.setBleedBox(0, 0, 630, 630);
    page.drawImage(image, { x: 0, y: 0, width: 630, height: 630 });
    await writeFile(join(directory, side + '.png'), art.readingPages[index]!);
  }
  await writeFile(
    join(directory, specification ? 'excerpt.pdf' : 'spread.pdf'),
    await excerpt.save(),
  );
  process.stdout.write(
    `Native ${art.nativeWidth} × ${art.nativeHeight}, ${art.effectivePpi.toFixed(1)} effective PPI\n`,
  );
}

main().catch((error: Error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
