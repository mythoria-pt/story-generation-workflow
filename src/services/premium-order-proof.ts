import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { z } from 'zod';
import { CMYKConversionService } from './cmyk-conversion.js';
import { PrintService, printQrUrl, type PrintArtwork } from './print.js';
import {
  finishLuluPdf,
  inspectLuluAssets,
  loadSrgbProfile,
  luluSpinePoints,
} from './lulu-print-profile.js';

import {
  PREMIUM_EMBEDDED_LETTERING_EDITION,
  premiumAsset,
  premiumManifest,
  type PremiumManifest as PremiumPrintManifest,
  type PremiumAsset as Ref,
} from './premium-book-contract.js';
import { PREMIUM_READING_PPI } from './premium-book-artwork.js';
import { verifyPremiumAssetScope } from './premium-book-storage.js';
import { openingMotifPaths, openingInk, motifInk, motifAccent } from './premium-opening-design.js';
import {
  escapePremiumHtml as escape,
  premiumSpecificationStyles,
  renderPremiumSpecificationPage,
} from './premium-book-specification.js';
import {
  premiumTypesetStyles,
  renderPremiumTypesetPage,
  type PremiumTypesetPage,
} from './premium-book-typesetting.js';

export const squarePackage = '0850X0850.FC.PRE.CW.080CW444.MXX';
export const legacySquarePackage = '0850X0850FCPRECW080CW444MXX';
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
    if (!p.artwork && p.reading) verifyPremiumAssetScope(storyId, p.reading);
  }
  verifyPremiumAssetScope(storyId, book.covers.front);
  verifyPremiumAssetScope(storyId, book.covers.back);
  if (book.motifArtwork) verifyPremiumAssetScope(storyId, book.motifArtwork);
  return book;
}

export const casewrap = { width: 1368, height: 738 };
const casewrapPanel = { width: 675, height: 738 };
const interiorPage = { width: 630, height: 630 };
const casewrapPpi = 304;
const pointsPerInch = 72;
const invitationArtwork = 'https://storage.googleapis.com/premium-render/brand/';
export async function loadPremiumPublicationQr(url: string): Promise<PrintArtwork> {
  if (url !== printQrUrl) throw new Error('Unexpected premium publication image');
  return {
    bytes: await readFile(join('print-assets', 'premium-invitation', 'publication-qr.png')),
    contentType: 'image/png',
  };
}

export function assertSquareCasewrap(d: { width: number; height: number }, pageCount = 32) {
  const spine = luluSpinePoints('hardcover', pageCount, d.width);
  const panelWidth = (d.width - spine) / 2;
  const expectedPanelFromHeight = 612 + (d.height - 612) / 2;
  if (
    d.width < 1332 ||
    d.width > 1404 ||
    d.height < 702 ||
    d.height > 774 ||
    Math.abs(panelWidth - expectedPanelFromHeight) > 2
  )
    throw new Error('Supplier square casewrap differs from the short hardcover template');
}

function renderOpeningPage(
  page: PremiumPrintManifest['pages'][number],
  design: PremiumPrintManifest['openingDesign'],
  motifUrl: string | undefined,
) {
  const colors = design ? ` style="background:${design.background};color:${openingInk}"` : '';
  let ornament = '';
  if (design && (page.kind === 'title' || page.kind === 'dedication')) {
    const [main, accent] = openingMotifPaths[design.motif];
    ornament = motifUrl
      ? `<img class="opening-motif bespoke" src="${motifUrl}" alt="">`
      : `<svg class="opening-motif" aria-hidden="true" viewBox="0 0 64 52" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${main}" stroke="${motifInk}" stroke-width="1.65"/><path d="${accent}" stroke="${motifAccent}" stroke-width="1.2"/></svg>`;
  }
  const qr = page.kind === 'copyright' ? `<img class="qr" src="${printQrUrl}">` : '';
  return `<section class="opening"${colors}><div class="fit opening-copy ${page.kind}">${escape(page.text)}${qr}${ornament}</div></section>`;
}

function squarePageDocument(
  locale: PremiumPrintManifest['opening']['locale'],
  dimensions: { width: number; height: number },
  styles: string,
  content: string,
) {
  const { width, height } = dimensions;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>
    @page{size:${width}pt ${height}pt;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Georgia,'Liberation Serif',serif;color:#222f2c}
    section{position:relative;width:${width}pt;height:${height}pt;overflow:hidden;break-after:page;background:#fbf5e6}section:last-child{break-after:auto}
    ${styles}</style></head><body>${content}</body></html>`;
}

export async function validatePremiumTypesetPages(
  locale: PremiumPrintManifest['opening']['locale'],
  audience: NonNullable<PremiumPrintManifest['audience']>,
  pages: readonly PremiumTypesetPage[],
): Promise<number[]> {
  if (pages.length === 0) return [];
  const html = squarePageDocument(
    locale,
    interiorPage,
    await premiumTypesetStyles(),
    pages.map((page) => renderPremiumTypesetPage(page, audience)).join(''),
  );
  const print = new PrintService('hardcover', async () => undefined);
  return (await print.findTextOverflow(html)).map(Number);
}

async function squareLayout(
  book: PremiumPrintManifest,
  part: 'interior' | 'cover',
  load: (ref: Ref) => Promise<Buffer>,
  loadBrand: (url: string) => Promise<PrintArtwork>,
  pages = book.pages,
  coverDimensions?: { width: number; height: number },
  coverPageCount: 32 | 33 | 34 = book.format.pageCount,
) {
  const cover = part === 'cover';
  const embeddedLettering = book.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
  const showClassicSpecification = !cover && embeddedLettering;
  const dimensions = cover ? (coverDimensions ?? casewrap) : interiorPage;
  const spine = cover ? luluSpinePoints('hardcover', coverPageCount, dimensions.width) : 0;
  const panelPts = cover
    ? { width: (dimensions.width - spine) / 2, height: dimensions.height }
    : casewrapPanel;
  const hasTypesetPages = !cover && pages.some(({ renderMode }) => renderMode === 'typeset');
  const typesetStyles = hasTypesetPages ? await premiumTypesetStyles() : '';
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
  const invitationQr = book.opening.locale + '.png';
  const motifUrl =
    !cover && book.openingDesign && book.motifArtwork
      ? 'https://storage.googleapis.com/premium-render/motifs/' + book.motifArtwork.sha256
      : undefined;
  const coverBg = book.openingDesign?.background
    ? ` style="background:${book.openingDesign.background}"`
    : '';
  const content = cover
    ? `<section${coverBg}>` + panel('back') + panel('front') + '</section>'
    : pages
        .map((p) => {
          if (showClassicSpecification && p.kind === 'copyright')
            return renderPremiumSpecificationPage(book, {
              logoUrl: `${invitationArtwork}mythoria-logo.png`,
              qrUrl: printQrUrl,
            });
          if (p.kind === 'invitation' && p.link) {
            const [heading, body] = p.text.split('\n\n');
            return `<section class="invitation"><div class="invitation-copy fit"><img class="brand" src="${invitationArtwork}mythoria-logo.png"><h1>${escape(heading ?? '')}</h1><p>${escape(body ?? '')}</p><p class="invitation-label">${escape(p.link.label)}</p><img class="invite-qr" src="${invitationArtwork}${invitationQr}"><p class="address">${escape(new URL(p.link.href).host)}</p></div></section>`;
          }
          if (p.renderMode === 'typeset') {
            if (!book.audience) throw new Error('Missing premium typesetting audience');
            return renderPremiumTypesetPage(p, book.audience, book.openingDesign?.background);
          }
          if (!p.artwork) return renderOpeningPage(p, book.openingDesign, motifUrl);
          const illustration = '<img class="art" src="' + artUrl(p.artwork) + '">';
          if (embeddedLettering || !p.text) return '<section>' + illustration + '</section>';
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
  const styles =
    '.art{position:absolute;width:630pt;height:630pt}.line,.cover-copy{position:absolute;white-space:pre-line;overflow-wrap:anywhere;background:#fbf5e6;padding:7pt 11pt;font-size:22pt;line-height:1.24}' +
    '.opening{display:grid;place-items:center}.opening-copy{width:490pt;max-height:510pt;white-space:pre-line;overflow-wrap:anywhere;font-size:20pt;line-height:1.38}.title,.dedication{text-align:center}.title{font-size:30pt}.qr{display:block;width:60pt;height:60pt;margin:20pt auto 0}.opening-motif{display:block;width:80pt;height:65pt;margin:20pt auto 0}' +
    '.opening-motif.bespoke{height:80pt}.invitation{display:grid;place-items:center;background:#fefbf6;text-align:center}.invitation-copy{width:450pt;max-height:490pt;color:#243735}.invitation .brand{width:168pt;height:auto}.invitation h1{margin:20pt 0 8pt;font-size:27pt;line-height:1.2}.invitation p{margin:0;font-size:18pt;line-height:1.35}.invitation .invitation-label{margin:22pt 0 7pt;font-weight:bold}.invite-qr{display:block;width:72pt;height:72pt;margin:auto}.invitation .address{font-size:13pt;margin-top:4pt}' +
    `.panel{position:absolute;width:${panelPts.width}pt;height:${panelPts.height}pt;overflow:hidden}.panel img{width:100%;height:100%}.back{left:0}.front{right:0}.cover-copy{top:100pt;left:96pt;right:96pt;max-height:465pt;font-size:18pt}.front .cover-copy{font-size:36pt;text-align:center}` +
    (showClassicSpecification ? premiumSpecificationStyles : '') +
    typesetStyles;
  const html = squarePageDocument(book.opening.locale, dimensions, styles, content);
  const print = new PrintService('hardcover', async (url) => {
    if (url === printQrUrl) return loadBrand(url);
    if (url === motifUrl && book.motifArtwork && book.openingDesign) {
      const background = book.openingDesign.background;
      const bytes = await sharp(await load(book.motifArtwork), { limitInputPixels: 4_194_304 })
        .resize(448, 448, { fit: 'contain', background })
        .flatten({ background })
        .png()
        .toBuffer();
      return { bytes, contentType: 'image/png' };
    }
    for (const file of ['mythoria-logo.png', invitationQr]) {
      if (url === invitationArtwork + file) {
        return {
          bytes: await readFile(join('print-assets', 'premium-invitation', file)),
          contentType: 'image/png',
        };
      }
    }
    const ref = sources.get(url);
    if (!ref) return undefined;
    const bytes = await load(ref);
    const meta = await sharp(bytes).metadata();
    const pixelsAt = (points: number, ppi: number) => Math.round((points * ppi) / pointsPerInch);
    const minPixels = pixelsAt(interiorPage.width, cover && embeddedLettering ? casewrapPpi : 300);
    if (
      meta.format !== 'jpeg' ||
      meta.width !== meta.height ||
      !meta.width ||
      meta.width < minPixels
    )
      throw new Error('Invalid square full-bleed print artwork');
    if (!cover) return { bytes, contentType: 'image/jpeg' };
    // Keep the trim art square. Carry its outside edges around the boards without stretching faces.
    const panelWidth = pixelsAt(panelPts.width, casewrapPpi);
    const panelHeight = pixelsAt(panelPts.height, casewrapPpi);
    const size = pixelsAt(interiorPage.width, casewrapPpi);
    const dx = Math.max(0, panelWidth - size),
      dy = Math.max(0, panelHeight - size);
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
  return { print, html, dimensions };
}

export async function premiumManualTextFits(
  book: PremiumPrintManifest,
  page: PremiumPrintManifest['pages'][number],
  load: (ref: Ref) => Promise<Buffer>,
) {
  const interior = await squareLayout(book, 'interior', load, loadPremiumPublicationQr, [page]);
  if ((await interior.print.findTextOverflow(interior.html)).length) return false;
  if (page.kind !== 'synopsis') return true;
  const cover = await squareLayout(book, 'cover', load, loadPremiumPublicationQr);
  return (await cover.print.findTextOverflow(cover.html)).length === 0;
}

export async function renderSquarePdf(
  book: PremiumPrintManifest,
  dir: string,
  part: 'interior' | 'cover',
  load: (ref: Ref) => Promise<Buffer>,
  loadBrand: (url: string) => Promise<PrintArtwork>,
  options?: {
    coverDimensions?: { width: number; height: number };
    coverPageCount?: 32 | 33 | 34;
    lulu?: boolean;
  },
) {
  const { print, html, dimensions } = await squareLayout(
    book,
    part,
    load,
    loadBrand,
    book.pages,
    options?.coverDimensions,
    options?.coverPageCount,
  );
  const cover = part === 'cover';
  const { width, height } = dimensions;
  const path = join(dir, part + '.pdf');
  await print.renderPDF(html, {
    width: (width * 25.4) / 72,
    height: (height * 25.4) / 72,
    outputPath: path,
    checkTextFit: true,
  });
  let pdfBytes = await readFile(path);
  if (options?.lulu) {
    const flatPath = join(dir, part + '-flat.pdf');
    await new CMYKConversionService().flattenForLulu(path, flatPath, casewrapPpi);
    pdfBytes = await readFile(flatPath);
  }
  // All content is opaque JPEG, solid CSS colours and embedded vector text.
  const output = await finishLuluPdf(pdfBytes, dimensions, !cover, await loadSrgbProfile());
  if ((await PDFDocument.load(output)).getPageCount() !== (cover ? 1 : book.format.pageCount))
    throw new Error('Unexpected premium PDF pagination');
  await writeFile(path, output);
  return { bytes: output, issues: await inspectLuluAssets(path) };
}

export async function renderSquarePagePreviews(
  book: PremiumPrintManifest,
  pages: PremiumPrintManifest['pages'],
  load: (ref: Ref) => Promise<Buffer>,
  loadBrand: (url: string) => Promise<PrintArtwork>,
) {
  const { print, html, dimensions } = await squareLayout(book, 'interior', load, loadBrand, pages);
  const pixels = (points: number) => Math.round((points * PREMIUM_READING_PPI) / pointsPerInch);
  const media = pixels(dimensions.width);
  const bleed = pixels(book.format.bleedPoints);
  const size = pixels(book.format.trimPoints);
  const captures = await print.renderPageImages(html, media);
  if (captures.length !== pages.length) throw new Error('Unexpected premium preview page count');
  return Promise.all(
    captures.map(async (bytes) => {
      const image = sharp(bytes);
      const metadata = await image.metadata();
      if (metadata.width !== media || metadata.height !== media) {
        throw new Error('Unexpected premium preview dimensions');
      }
      return image.extract({ left: bleed, top: bleed, width: size, height: size }).png().toBuffer();
    }),
  );
}
