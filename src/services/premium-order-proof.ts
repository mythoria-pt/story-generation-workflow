import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { z } from 'zod';
import { PrintService, printQrUrl, type PrintArtwork } from './print.js';
import { finishLuluPdf, inspectLuluAssets, loadSrgbProfile } from './lulu-print-profile.js';

import {
  premiumAsset,
  premiumManifest,
  type PremiumManifest as PremiumPrintManifest,
  type PremiumAsset as Ref,
} from './premium-book-contract.js';
import { verifyPremiumAssetScope } from './premium-book-storage.js';
import { openingMotifPaths, openingInk, motifInk, motifAccent } from './premium-opening-design.js';

export const squarePackage = '0850X0850FCPRECW080CW444MXX';
export const publishedPremium = z.object({
  version: z.literal(1),
  type: z.literal('premium_children'),
  state: z.literal('published'),
  revision: z.uuid(),
  manifest: premiumAsset,
});
const safeBox = z
  .object({
    x: z.number().min(0.06),
    y: z.number().min(0.06),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .refine((b) => b.x + b.width <= 0.94 && b.y + b.height <= 0.94);
export function validatePremiumManifest(value: unknown, storyId: string, revision: string) {
  const book = premiumManifest.parse(value);
  if (book.storyId !== storyId || book.revision !== revision)
    throw new Error('Premium edition mismatch');
  for (const p of book.pages) {
    if (p.textBox) safeBox.parse(p.textBox);
    if (p.artwork) verifyPremiumAssetScope(storyId, p.artwork);
  }
  verifyPremiumAssetScope(storyId, book.covers.front);
  verifyPremiumAssetScope(storyId, book.covers.back);
  return book;
}

function escape(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
export const casewrap = { width: 1368, height: 738 };
export function assertSquareCasewrap(d: { width: number; height: number }) {
  if (Math.abs(d.width - casewrap.width) > 0.1 || Math.abs(d.height - casewrap.height) > 0.1)
    throw new Error('Supplier square casewrap differs from the approved 32-page template');
}

function renderOpeningPage(
  page: PremiumPrintManifest['pages'][number],
  design: PremiumPrintManifest['openingDesign'],
) {
  const colors = design ? ` style="background:${design.background};color:${openingInk}"` : '';
  let ornament = '';
  if (design && (page.kind === 'title' || page.kind === 'dedication')) {
    const [main, accent] = openingMotifPaths[design.motif];
    ornament = `<svg class="opening-motif" aria-hidden="true" viewBox="0 0 64 52" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${main}" stroke="${motifInk}" stroke-width="1.65"/><path d="${accent}" stroke="${motifAccent}" stroke-width="1.2"/></svg>`;
  }
  const qr = page.kind === 'copyright' ? `<img class="qr" src="${printQrUrl}">` : '';
  return `<section class="opening"${colors}><div class="fit opening-copy ${page.kind}">${escape(page.text)}${qr}${ornament}</div></section>`;
}

export async function renderSquarePdf(
  book: PremiumPrintManifest,
  dir: string,
  part: 'interior' | 'cover',
  load: (ref: Ref) => Promise<Buffer>,
  loadBrand: (url: string) => Promise<PrintArtwork>,
) {
  const cover = part === 'cover';
  const dimensions = cover ? casewrap : { width: 630, height: 630 };
  const sources = new Map<string, Ref>();
  function artUrl(ref: Ref) {
    const url = 'https://storage.googleapis.com/premium-render/' + ref.sha256;
    sources.set(url, ref);
    return url;
  }
  const panel = (side: 'front' | 'back') =>
    '<div class="panel ' +
    side +
    '"><img src="' +
    artUrl(book.covers[side]) +
    '"><div class="cover-copy fit">' +
    escape(side === 'front' ? book.opening.title : book.opening.synopsis) +
    '</div></div>';
  const content = cover
    ? '<section>' + panel('back') + panel('front') + '</section>'
    : book.pages
        .map((p) => {
          if (!p.artwork) return renderOpeningPage(p, book.openingDesign);
          const illustration = '<img class="art" src="' + artUrl(p.artwork) + '">';
          if (!p.text) return '<section>' + illustration + '</section>';
          const b = p.textBox ?? { x: 0.1, y: 0.09, width: 0.8, height: 0.2 };
          const style =
            'left:' +
            (9 + 612 * b.x) +
            'pt;top:' +
            (9 + 612 * b.y) +
            'pt;width:' +
            612 * b.width +
            'pt;max-height:' +
            612 * b.height +
            'pt';
          return (
            '<section>' +
            illustration +
            '<div class="line fit" style="' +
            style +
            '">' +
            escape(p.text) +
            '</div></section>'
          );
        })
        .join('');
  const { width, height } = dimensions;
  const html =
    '<!doctype html><html lang="' +
    escape(book.opening.locale) +
    '"><head><style>' +
    '@page{size:' +
    width +
    'pt ' +
    height +
    'pt;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Georgia,serif;color:#222f2c}' +
    'section{position:relative;width:' +
    width +
    'pt;height:' +
    height +
    'pt;overflow:hidden;break-after:page;background:#fbf5e6}section:last-child{break-after:auto}' +
    '.art{position:absolute;width:630pt;height:630pt}.line,.cover-copy{position:absolute;white-space:pre-line;overflow-wrap:anywhere;background:#fbf5e6;padding:7pt 11pt;font-size:22pt;line-height:1.24}' +
    '.opening{display:grid;place-items:center}.opening-copy{width:490pt;max-height:510pt;white-space:pre-line;overflow-wrap:anywhere;font-size:20pt;line-height:1.38}.title,.dedication{text-align:center}.title{font-size:30pt}.qr{display:block;width:60pt;height:60pt;margin:20pt auto 0}.opening-motif{display:block;width:80pt;height:65pt;margin:20pt auto 0}' +
    '.panel{position:absolute;width:675pt;height:738pt;overflow:hidden}.panel img{width:100%;height:100%}.back{left:0}.front{right:0}.cover-copy{top:100pt;left:96pt;right:96pt;max-height:465pt;font-size:18pt}.front .cover-copy{font-size:36pt;text-align:center}' +
    '</style></head><body>' +
    content +
    '</body></html>';
  const print = new PrintService('hardcover', async (url) => {
    if (url === printQrUrl) return loadBrand(url);
    const ref = sources.get(url);
    if (!ref) return undefined;
    const bytes = await load(ref);
    const meta = await sharp(bytes).metadata();
    if (meta.format !== 'jpeg' || meta.width !== meta.height || !meta.width || meta.width < 2625)
      throw new Error('Invalid square full-bleed print artwork');
    if (!cover) return { bytes, contentType: 'image/jpeg' };
    // Keep the trim art square. Carry its outside edges around the boards without stretching faces.
    const ppi = 304,
      panelWidth = 2850,
      panelHeight = 3116;
    const size = Math.round(ppi * 8.75);
    const dx = panelWidth - size,
      dy = panelHeight - size;
    const panelBytes = await sharp(bytes)
      .resize(size, size)
      .extend({
        left: Math.floor(dx / 2),
        right: Math.ceil(dx / 2),
        top: Math.floor(dy / 2),
        bottom: Math.ceil(dy / 2),
        extendWith: 'mirror',
      })
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();
    return { bytes: panelBytes, contentType: 'image/jpeg' };
  });
  const path = join(dir, part + '.pdf');
  await print.renderPDF(html, {
    width: (width * 25.4) / 72,
    height: (height * 25.4) / 72,
    outputPath: path,
    checkTextFit: true,
  });
  // All content is opaque JPEG, solid CSS colours and embedded vector text.
  const output = await finishLuluPdf(
    await readFile(path),
    dimensions,
    !cover,
    await loadSrgbProfile(),
  );
  if ((await PDFDocument.load(output)).getPageCount() !== (cover ? 1 : 32))
    throw new Error('Unexpected premium PDF pagination');
  await writeFile(path, output);
  return { bytes: output, issues: await inspectLuluAssets(path) };
}
