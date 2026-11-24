import { describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';
import {
  generatedPremiumBoard,
  premiumBoard,
  premiumManifest,
  premiumOpeningDesign,
} from '@/services/premium-book-contract.js';
import { buildPremiumStoryboardPrompt } from '@/services/premium-book-storyboard.js';
import {
  motifAccent,
  motifInk,
  openingInk,
  openingMotifPaths,
  premiumOpeningColors,
  premiumOpeningMotifs,
} from '@/services/premium-opening-design.js';
import { renderSquarePdf } from '@/services/premium-order-proof.js';
import { PrintService } from '@/services/print.js';
import { premiumManifestFixture } from './fixtures/premium-book.js';

const design = { motif: 'paper_boat', background: '#e1f0eb' } as const;

function boardFixture() {
  const book = premiumManifestFixture();
  const panel = { text: 'O barco flutua.', action: 'Um barco flutua.' };
  return {
    synopsis: book.opening.synopsis,
    motifBrief: 'Um barco de papel dobrado com traços azul-petróleo.',
    motifSpread: 1,
    visualGuide: book.visualGuide,
    front: 'O barco.',
    back: 'O mar.',
    opener: panel,
    ending: panel,
    spreads: book.spreads.map((spread) => ({
      textLayout: spread.textLayout,
      leftText: book.pages[spread.leftPage - 1]?.text,
      rightText: book.pages[spread.rightPage - 1]?.text,
      action: spread.action,
      leftDescription: spread.leftDescription ?? '',
    })),
  };
}

function luminance(color: string): number {
  const channel = (offset: number) => {
    const component = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

describe('premium opening design', () => {
  it('requires one approved theme on new boards and keeps earlier boards and editions readable', () => {
    const oldBoard = boardFixture();
    const oldEdition = premiumManifestFixture();
    expect(premiumBoard.parse(oldBoard).openingDesign).toBeUndefined();
    expect(premiumManifest.parse(oldEdition).openingDesign).toBeUndefined();
    expect(generatedPremiumBoard.safeParse(oldBoard).success).toBe(false);
    expect(
      generatedPremiumBoard.parse({ ...oldBoard, openingDesign: design }).openingDesign,
    ).toEqual(design);
    expect(premiumBoard.parse({ ...oldBoard, openingDesign: design }).openingDesign).toEqual(
      design,
    );
    expect(premiumManifest.parse({ ...oldEdition, openingDesign: design }).openingDesign).toEqual(
      design,
    );
  });

  it.each([
    { ...design, motif: 'an arbitrary drawing' },
    { ...design, motif: '<svg />' },
    { ...design, background: '#000000' },
    { ...design, background: 'url(/photo.png)' },
    { ...design, background: ['#e1f0eb', '#f9efd9'] },
  ])('rejects unsupported design value %p on both stored and generated books', (openingDesign) => {
    expect(premiumOpeningDesign.safeParse(openingDesign).success).toBe(false);
    expect(generatedPremiumBoard.safeParse({ ...boardFixture(), openingDesign }).success).toBe(
      false,
    );
    expect(premiumManifest.safeParse({ ...premiumManifestFixture(), openingDesign }).success).toBe(
      false,
    );
  });

  it.each(premiumOpeningColors)('keeps text and both drawing inks legible on %s', (background) => {
    expect(premiumOpeningDesign.safeParse({ ...design, background }).success).toBe(true);
    const paper = luminance(background);
    expect(paper).toBeGreaterThan(0.7);
    for (const ink of [openingInk, motifInk, motifAccent]) {
      expect((paper + 0.05) / (luminance(ink) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('provides two visible drawing paths for every selectable motif', async () => {
    expect(Object.keys(openingMotifPaths).sort()).toEqual([...premiumOpeningMotifs].sort());
    expect(new Set(Object.values(openingMotifPaths).map((entry) => entry[0])).size).toBe(
      premiumOpeningMotifs.length,
    );
    for (const motif of premiumOpeningMotifs) {
      for (const path of openingMotifPaths[motif]) {
        const glyph = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="52"><path fill="none" stroke="black" d="${path}"/></svg>`,
        );
        const { data, info } = await sharp(glyph)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const alpha = info.channels - 1;
        const opaque = data.filter((value, index) => index % info.channels === alpha && value > 0);
        expect(opaque.length).toBeGreaterThan(10);
      }
    }
  });

  it('asks for the story’s own symbol and one pastel for all four opening pages', () => {
    const prompt = buildPremiumStoryboardPrompt({
      audience: 'children_3-6',
      opening: { title: 'Inês e o Barquinho', locale: 'pt-PT' },
      direction: 'Um barco de papel a descer o ribeiro.',
      characters: 'Inês',
    });
    expect(prompt).toContain('Choose openingDesign once for this book');
    expect(prompt).toContain(
      'a recurring object, a meaningful detail or the feeling of this story',
    );
    expect(prompt).toContain('Choose one light pastel background');
    expect(prompt).toContain('for the four opening pages');
    expect(prompt).toContain(
      'Leave motifs and opening backgrounds out of the narrative illustration instructions',
    );
    for (const value of [...premiumOpeningMotifs, ...premiumOpeningColors]) {
      expect(prompt).toContain(value);
    }
  });

  it('typesets the pastel on all four opening pages and draws the motif on title and dedication only', async () => {
    const stop = new Error('captured renderer HTML');
    const capture = jest.spyOn(PrintService.prototype, 'renderPDF').mockRejectedValue(stop);
    const unavailable = jest.fn(async () => {
      throw new Error('unexpected image access');
    });
    try {
      const original = premiumManifestFixture();
      await expect(
        renderSquarePdf(
          { ...original, openingDesign: design },
          '',
          'interior',
          unavailable,
          unavailable,
        ),
      ).rejects.toThrow(stop.message);
      const html = capture.mock.calls[0]?.[0] ?? '';
      const pages = html.match(/<section class="opening".*?<\/section>/gs) ?? [];
      expect(pages).toHaveLength(4);
      expect(pages.every((page) => page.includes(`background:${design.background}`))).toBe(true);
      expect(pages.map((page) => page.includes('class="opening-motif"'))).toEqual([
        true,
        false,
        true,
        false,
      ]);
      expect(pages[0]).toContain(openingMotifPaths.paper_boat[0]);
      expect(pages[1]).toContain('class="qr"');
      expect(html.split(design.background)).toHaveLength(5);

      await expect(
        renderSquarePdf(original, '', 'interior', unavailable, unavailable),
      ).rejects.toThrow(stop.message);
      const historical = capture.mock.calls[1]?.[0] ?? '';
      expect(historical).not.toContain('class="opening-motif"');
      expect(historical).not.toContain(design.background);
      expect(unavailable).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });
});
