import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { describe, it, expect } from '@jest/globals';
import { luluInterior, luluSpinePoints, finishLuluPdf } from '@/services/lulu-print-profile.js';

describe('Lulu print geometry', () => {
  it.each([
    [24, 18],
    [84, 18],
    [85, 36],
    [140, 36],
    [141, 45],
    [799, 148.5],
    [800, 153],
  ])('uses the casewrap spine band for %i pages', (pages, expected) => {
    expect(luluSpinePoints('hardcover', pages, 1200)).toBe(expected);
  });
  it('requires a matching supplier canvas and binding page range', () => {
    for (const n of [31, 801]) expect(() => luluSpinePoints('paperback', n, 900)).toThrow();
    expect(() => luluSpinePoints('hardcover', 23, 1100)).toThrow();
    expect(() => luluSpinePoints('paperback', 32, 1100)).toThrow();
    expect(() => luluSpinePoints('hardcover', 32, 900)).toThrow();
    expect(luluSpinePoints('paperback', 32, 866.57)).toBeCloseTo(9.514);
  });
  it('produces uniform A5 boxes with a 9 pt inset and tagged RGB', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([438, 613]);
    const bytes = await finishLuluPdf(
      await doc.save(),
      luluInterior,
      true,
      new Uint8Array([1, 2, 3]),
    );
    for (const page of (await PDFDocument.load(bytes)).getPages()) {
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, ...luluInterior });
      expect(page.getBleedBox()).toEqual(page.getMediaBox());
      expect(page.getTrimBox().x).toBe(9);
      expect(page.getTrimBox().height).toBeCloseTo(595.276);
      const colors = page.node.Resources()?.lookup(PDFName.of('ColorSpace'), PDFDict);
      expect(colors?.has(PDFName.of('DefaultRGB'))).toBe(true);
    }
    await expect(
      finishLuluPdf(await doc.save(), luluInterior, false, new Uint8Array()),
    ).rejects.toThrow('one spread');
    await expect(
      finishLuluPdf(await doc.save(), { width: 420, height: 595 }, true, new Uint8Array()),
    ).rejects.toThrow('geometry');
  });
});
