import {
  premiumInvitationManifestFixture,
  premiumLetteredManifestFixture,
  premiumManifestFixture,
} from './fixtures/premium-book.js';
import { premiumCoverLogoForStyle } from '@/services/premium-cover-brand.js';
import { premiumOpeningPages } from '@/services/premium-book-opening.js';
import { PrintService } from '@/services/print.js';
import { readPremiumObject } from '@/services/premium-book-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import { describe, expect, it, jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import { OrderProofRequest } from '@/services/order-proof.js';
import {
  defaultPremiumSpreadTextBoxes,
  lowerPremiumSpreadTextBoxes,
} from '@/services/premium-book-artwork.js';
import {
  assertSquareCasewrap,
  legacySquarePackage,
  premiumManualTextFits,
  renderSquarePagePreviews,
  renderSquarePdf,
  squarePackage,
  validatePremiumManifest,
  validatePremiumTypesetPages,
} from '@/services/premium-order-proof.js';
import { CMYKConversionService } from '@/services/cmyk-conversion.js';

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
  it('composes the generated-title cover with a style-matched logo and QR on the back only', async () => {
    const book = premiumLetteredManifestFixture();
    book.generationDesignVersion = 1;
    book.coverBrandLogo = premiumCoverLogoForStyle('watercolor');
    const stop = new Error('captured HTML');
    const capture = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue(stop);
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(renderSquarePdf(book, '', 'cover', unavailable, unavailable)).rejects.toThrow(
        stop.message,
      );
      const html = capture.mock.calls[0]![0];
      const front = html.match(/<div class="panel front">.*?<\/div>/)?.[0];
      const back = html.match(/<div class="panel back">.*?<\/div>/)?.[0];
      expect(front).toContain(`alt="${book.opening.title}"`);
      expect(front).not.toContain('cover-badge');
      expect(back).toContain('brand/watercolor.jpg');
      expect(back).toContain('alt="mythoria.pt"');
      expect(back).not.toContain(book.opening.synopsis);
      expect(html).not.toContain('class="cover-copy fit"');
      expect(premiumCoverLogoForStyle('pixar_style')).toBe('pixar.jpg');
      expect(premiumCoverLogoForStyle('oil_painting')).toBe('oil-painting.jpg');
      expect(premiumCoverLogoForStyle('euro_comic_book')).toBe('mythoria-logo.png');

      book.coverBrandLogo = premiumCoverLogoForStyle(undefined);
      await expect(renderSquarePdf(book, '', 'cover', unavailable, unavailable)).rejects.toThrow(
        stop.message,
      );
      expect(capture.mock.calls[1]![0]).toContain('brand/mythoria-logo.png');
    } finally {
      capture.mockRestore();
    }
  });

  it('also fits a manually edited synopsis in the back cover', async () => {
    const book = premiumManifestFixture();
    book.opening.synopsis = 'A Inês conta <uma história>.';
    const synopsis = { ...book.pages[3]!, text: `Sinopse\n\n${book.opening.synopsis}` };
    const fit = jest
      .spyOn(PrintService.prototype, 'findTextOverflow')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['']);
    try {
      await expect(
        premiumManualTextFits(book, synopsis, async () => Buffer.alloc(0)),
      ).resolves.toBe(false);
      expect(fit).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Sinopse\n\nA Inês conta &lt;uma história&gt;.'),
      );
      expect(fit).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('cover-copy fit">A Inês conta &lt;uma história&gt;.'),
      );
    } finally {
      fit.mockRestore();
    }
  });

  it('requires the pinned hardcover edition and a package only for Lulu', () => {
    expect(OrderProofRequest.parse(input)).toMatchObject(input);
    expect(OrderProofRequest.parse({ ...input, premiumPageCount: 33 }).premiumPageCount).toBe(33);
    expect(OrderProofRequest.safeParse({ ...input, premiumPageCount: 34 }).success).toBe(false);
    expect(
      OrderProofRequest.safeParse({ ...input, provider: 'manual', podPackageId: undefined })
        .success,
    ).toBe(true);
    for (const fields of [
      { binding: 'paperback' },
      { provider: 'manual', coverDimensions: { width: 1368, height: 738 } },
      { premiumBook: undefined },
      { podPackageId: undefined },
      { storyId: randomUUID() },
      { premiumBook: { ...pin, state: 'draft' } },
    ]) {
      expect(OrderProofRequest.safeParse({ ...input, ...fields }).success).toBe(false);
    }
    const coverDimensions = { width: 1368, height: 738 };
    for (const [premiumPageCount, coverPageCount, accepted] of [
      [32, 32, true],
      [33, 33, true],
      [33, 34, true],
      [32, 34, false],
      [33, 32, false],
      [33, 35, false],
    ]) {
      expect(
        OrderProofRequest.safeParse({ ...input, premiumPageCount, coverDimensions, coverPageCount })
          .success,
      ).toBe(accepted);
    }
    expect(
      OrderProofRequest.safeParse({ ...input, premiumPageCount: 33, coverPageCount: 34 }).success,
    ).toBe(false);
  });
  it('renders one branded invitation after the story and reuses a selected custom motif only on pages 1 and 3', async () => {
    const book = premiumInvitationManifestFixture();
    book.openingDesign = { background: '#f9efd9', motif: 'paper_boat' };
    book.motifArtwork = { ...book.reference, key: book.reference.key.replace(/\.jpg$/, '.png') };
    const capture = jest
      .spyOn(PrintService.prototype, 'renderPDF')
      .mockRejectedValue(new Error('captured HTML'));
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(renderSquarePdf(book, '', 'interior', unavailable, unavailable)).rejects.toThrow(
        'captured HTML',
      );
      const pages = capture.mock.calls[0]![0].match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
      expect(pages).toHaveLength(33);
      expect(
        pages.flatMap((html, index) => (html.includes('/motifs/') ? [index + 1] : [])),
      ).toEqual([1, 3]);
      expect(pages[0]).toContain(book.motifArtwork.sha256);
      expect(pages[2]).toContain(book.motifArtwork.sha256);
      const closing = pages[32]!;
      expect(closing).toContain('Gostaste desta história?');
      expect(closing).toContain('Cria a tua história na Mythoria');
      expect(closing).toContain('mythoria-logo.png');
      expect(closing).toContain('pt-PT.png');
      expect(closing).not.toContain('opening-motif');
    } finally {
      capture.mockRestore();
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
    expect(() => assertSquareCasewrap({ width: 1368.2, height: 738 }, 33)).not.toThrow();
    expect(() => assertSquareCasewrap({ width: 1100, height: 738 })).toThrow();
    expect(() => assertSquareCasewrap({ width: 1368, height: 680 })).toThrow();
  });

  it('accepts dotted and legacy square SKUs and renders dynamic Lulu cover dimensions with flattening', async () => {
    expect(squarePackage).toBe('0850X0850.FC.PRE.CW.080CW444.MXX');
    expect(legacySquarePackage).toBe('0850X0850FCPRECW080CW444MXX');
    expect(
      OrderProofRequest.safeParse({ ...input, podPackageId: legacySquarePackage }).success,
    ).toBe(true);
    const book = premiumLetteredManifestFixture();
    const checked = validatePremiumManifest(book, book.storyId, book.revision);
    const capture = jest
      .spyOn(PrintService.prototype, 'renderPDF')
      .mockRejectedValue(new Error('captured HTML'));
    const flatten = jest.spyOn(CMYKConversionService.prototype, 'flattenForLulu');
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(
        renderSquarePdf(checked, '', 'cover', unavailable, unavailable, {
          coverDimensions: { width: 1368.2, height: 738 },
          lulu: true,
        }),
      ).rejects.toThrow('captured HTML');
      const [coverHtml, coverOptions] = capture.mock.calls[0]!;
      expect(coverHtml).toContain('width:675.1pt;height:738pt');
      expect(coverOptions.width).toBeCloseTo((1368.2 * 25.4) / 72, 2);
      expect(coverOptions.height).toBeCloseTo((738 * 25.4) / 72, 2);
      expect(flatten).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
      flatten.mockRestore();
    }
  });
  it('renders the declared lower panel in trim-relative points and retains existing upper panels', async () => {
    const book = premiumManifestFixture();
    const spread = book.spreads[0]!;
    const lowerPage = book.pages[spread.rightPage - 1]!;
    lowerPage.textBox = lowerPremiumSpreadTextBoxes(
      defaultPremiumSpreadTextBoxes(spread.textLayout),
    ).right;
    const checked = validatePremiumManifest(book, book.storyId, book.revision);
    const capture = jest
      .spyOn(PrintService.prototype, 'renderPDF')
      .mockRejectedValue(new Error('captured HTML'));
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(
        renderSquarePdf(checked, '', 'interior', unavailable, unavailable),
      ).rejects.toThrow('captured HTML');
      const pages = capture.mock.calls[0]![0].match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
      expect(pages[spread.rightPage - 1]).toContain('top:443.52pt');
      expect(pages[spread.rightPage - 1]).toContain(lowerPage.text);
      expect(pages[spread.leftPage - 1]).toContain('top:64.08pt');
      expect(capture.mock.calls[0]?.[1]).toMatchObject({ checkTextFit: true });
    } finally {
      capture.mockRestore();
    }
  });
  it('assembles a classic specification, all 28 narrative images, and the invitation on the pinned lettering edition', async () => {
    const book = premiumLetteredManifestFixture();
    const checked = validatePremiumManifest(book, book.storyId, book.revision);
    const capture = jest
      .spyOn(PrintService.prototype, 'renderPDF')
      .mockRejectedValue(new Error('captured HTML'));
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(
        renderSquarePdf(checked, '', 'interior', unavailable, unavailable),
      ).rejects.toThrow('captured HTML');
      await expect(renderSquarePdf(checked, '', 'cover', unavailable, unavailable)).rejects.toThrow(
        'captured HTML',
      );
      const pages = capture.mock.calls[0]![0].match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
      expect(pages).toHaveLength(33);
      expect(pages[1]).toContain('class="specification"');
      expect(pages[32]).toContain('class="invitation"');
      for (const page of book.pages.slice(4, 32)) {
        const html = pages[page.number - 1];
        expect(html).toBe(
          `<section><img class="art" src="https://storage.googleapis.com/premium-render/${page.artwork!.sha256}"></section>`,
        );
      }
      const [coverHtml, coverOptions] = capture.mock.calls[1]!;
      expect(coverHtml.match(/<section>/g)).toHaveLength(1);
      expect(coverHtml).toContain(book.opening.title);
      expect(coverHtml).toContain(book.opening.synopsis);
      expect(coverOptions.width).toBeCloseTo(482.6);
      expect(coverOptions.height).toBeCloseTo(260.35);
    } finally {
      capture.mockRestore();
    }
  });
  it('keeps older dedications and styles only the pinned author line in PDF and page previews', async () => {
    const book = premiumLetteredManifestFixture();
    book.opening.author = 'Fátima & Afonso';
    book.opening.dedication = 'Para ti.\n\nO nosso abraço.';
    const dedication = premiumOpeningPages(book.opening)[2];
    book.pages[2] = dedication;
    const captured = new Error('captured opening HTML');
    const pdf = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue(captured);
    const preview = jest
      .spyOn(PrintService.prototype, 'renderPageImages')
      .mockRejectedValue(captured);
    const unavailable = jest.fn(async () => Buffer.alloc(0));
    const dedicationPattern = /<div class="fit opening-copy dedication">.*?<\/div>/s;
    try {
      await expect(renderSquarePdf(book, '', 'interior', unavailable, unavailable)).rejects.toThrow(
        captured,
      );
      expect(pdf.mock.calls[0]![0].match(dedicationPattern)?.[0]).toContain(
        'O nosso abraço.\n\n– Fátima &amp; Afonso',
      );
      book.generationDesignVersion = 1;
      await expect(renderSquarePdf(book, '', 'interior', unavailable, unavailable)).rejects.toThrow(
        captured,
      );
      await expect(
        renderSquarePagePreviews(book, [dedication], unavailable, unavailable),
      ).rejects.toThrow(captured);
      const html = pdf.mock.calls[1]![0];
      const markup = html.match(dedicationPattern)?.[0];
      expect(html).toContain('.dedication-signature{font-size:14pt;font-style:italic}');
      expect(markup).toContain(
        'O nosso abraço.\n\n<span class="dedication-signature">– Fátima &amp; Afonso</span>',
      );
      expect(preview.mock.calls[0]![0].match(dedicationPattern)?.[0]).toBe(markup);
    } finally {
      pdf.mockRestore();
      preview.mockRestore();
    }
  });
  it('uses the same selectable typeset markup for square PDFs and reading previews', async () => {
    const book = premiumLetteredManifestFixture();
    book.spreadLayoutVersion = 1;
    book.audience = 'children_0-2';
    book.openingDesign = { background: '#f9efd9', motif: 'paper_boat' };
    const page = book.pages[6]!;
    page.renderMode = 'typeset';
    page.text = '«Olá, Maria da Conceição!»\n\nO avô sorriu & acenou.';
    delete page.artwork;
    const captured = new Error('captured HTML');
    const pdf = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue(captured);
    const preview = jest
      .spyOn(PrintService.prototype, 'renderPageImages')
      .mockRejectedValue(captured);
    const unavailable = jest.fn(async () => {
      throw new Error('Unexpected image access');
    });
    try {
      await expect(renderSquarePdf(book, '', 'interior', unavailable, unavailable)).rejects.toThrow(
        captured,
      );
      await expect(
        renderSquarePagePreviews(book, [page], unavailable, unavailable),
      ).rejects.toThrow(captured);
      const matchTypesetPage = /<section class="typeset .*?<\/section>/s;
      const printPage = pdf.mock.calls[0]![0].match(matchTypesetPage)?.[0];
      expect(printPage).toContain('typeset-recto typeset-younger');
      expect(printPage).toContain('background:#f9efd9;color:#243735');
      expect(printPage).toContain('«Olá, Maria da Conceição!»\n\nO avô sorriu &amp; acenou.');
      expect(printPage).not.toContain('<img');
      expect(preview.mock.calls[0]![0].match(matchTypesetPage)?.[0]).toBe(printPage);
    } finally {
      pdf.mockRestore();
      preview.mockRestore();
    }
  });
  it('measures candidate passages in their physical page geometry with the pinned book font', async () => {
    const measure = jest.spyOn(PrintService.prototype, 'findTextOverflow').mockResolvedValue(['9']);
    try {
      await expect(validatePremiumTypesetPages('de-DE', 'children_3-6', [])).resolves.toEqual([]);
      expect(measure).not.toHaveBeenCalled();
      await expect(
        validatePremiumTypesetPages('de-DE', 'children_3-6', [
          { number: 6, text: '„Grüß dich!“' },
          { number: 9, text: 'Mara-Luise aus Nordrhein-Westfalen wollte mitfahren.' },
        ]),
      ).resolves.toEqual([9]);
      const [html] = measure.mock.calls[0]!;
      expect(html).toContain('<html lang="de-DE">');
      expect(html).toContain('@page{size:630pt 630pt');
      expect(html).toContain('src: url(data:font/woff2;base64,');
      expect(html).toContain('class="typeset typeset-verso"');
      expect(html).toContain('class="typeset typeset-recto"');
      expect(html).toContain('data-fit-id="6" data-fit-font="Literata">„Grüß dich!“');
    } finally {
      measure.mockRestore();
    }
  });
  it('rejects an integrated edition with a missing invitation, overlay, or missing canonical narration', () => {
    const placed = premiumInvitationManifestFixture();
    const book = premiumLetteredManifestFixture();
    for (const fields of [
      { ...manifest, editionLayout: book.editionLayout },
      { ...book, pages: placed.pages },
      {
        ...book,
        pages: book.pages.map((page) => (page.number === 5 ? { ...page, text: '' } : page)),
      },
    ]) {
      expect(() => validatePremiumManifest(fields, book.storyId, book.revision)).toThrow();
    }
  });
  it('requires the frozen technical page and native art metadata on the embedded-lettering edition', () => {
    const book = premiumLetteredManifestFixture();
    const opener = book.natives.opener!;
    const spread = book.spreads[0]!;
    for (const fields of [
      { specification: undefined },
      { specification: { ...book.specification, promotion: 'Unexpected copy' } },
      { pages: book.pages.map((p) => (p.number === 2 ? { ...p, reading: book.reference } : p)) },
      { natives: {} },
      { natives: { ...book.natives, opener: { ...opener, nativeWidth: 1536 } } },
      { natives: { ...book.natives, [spread.id]: { ...spread, nativeWidth: 5280 } } },
    ]) {
      expect(() =>
        validatePremiumManifest({ ...book, ...fields }, book.storyId, book.revision),
      ).toThrow();
    }
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
  it('measures text overflow with FontFaceSet iteration and max-height allowance, rejecting missing fonts', async () => {
    const launchMock = jest.mocked(puppeteer.launch);
    const mockPage = {
      setRequestInterception: jest.fn(async () => undefined),
      setJavaScriptEnabled: jest.fn(async () => undefined),
      on: jest.fn(),
      setContent: jest.fn(async () => undefined),
      waitForNetworkIdle: jest.fn(async () => undefined),
      evaluate: jest.fn(async (fn: () => unknown) => fn()),
    };
    const mockBrowser = {
      newPage: jest.fn(async () => mockPage),
      close: jest.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(
      mockBrowser as unknown as Awaited<ReturnType<typeof puppeteer.launch>>,
    );

    const originalDocument = globalThis.document;
    const originalGetComputedStyle = globalThis.getComputedStyle;
    const fitElements = [
      {
        dataset: { fitId: '6', fitFont: 'Literata' },
        scrollHeight: 56,
        clientHeight: 54,
        scrollWidth: 632,
        clientWidth: 632,
        maxHeight: '640px',
      },
      {
        dataset: { fitId: '9', fitFont: 'Literata' },
        scrollHeight: 652,
        clientHeight: 640,
        scrollWidth: 632,
        clientWidth: 632,
        maxHeight: '640px',
      },
      {
        dataset: { fitId: '11' },
        scrollHeight: 200,
        clientHeight: 150,
        scrollWidth: 400,
        clientWidth: 400,
        maxHeight: 'none',
      },
    ];
    let loadedFonts: Array<{ family: string; status: string }> = [
      { family: '"Literata"', status: 'loaded' },
    ];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        fonts: {
          ready: Promise.resolve(),
          forEach() {
            throw new TypeError(
              "Failed to execute 'forEach' on 'FontFaceSet': The provided callback is no longer runnable.",
            );
          },
          *[Symbol.iterator]() {
            yield* loadedFonts;
          },
        },
        querySelectorAll: () => fitElements,
      },
    });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      writable: true,
      value: (el: (typeof fitElements)[number]) => ({ maxHeight: el.maxHeight }),
    });

    try {
      const printService = new PrintService();
      await expect(printService.findTextOverflow('<html></html>')).resolves.toEqual(['9', '11']);
      loadedFonts = [];
      await expect(printService.findTextOverflow('<html></html>')).rejects.toThrow(
        'Premium typesetting font is unavailable',
      );
      expect(mockBrowser.close).toHaveBeenCalledTimes(2);
    } finally {
      launchMock.mockReset();
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
      Object.defineProperty(globalThis, 'getComputedStyle', {
        configurable: true,
        writable: true,
        value: originalGetComputedStyle,
      });
    }
  });
});
