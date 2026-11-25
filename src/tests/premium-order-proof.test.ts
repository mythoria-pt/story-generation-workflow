import {
  premiumInvitationManifestFixture,
  premiumLetteredManifestFixture,
  premiumManifestFixture,
} from './fixtures/premium-book.js';
import { PrintService } from '@/services/print.js';
import { readPremiumObject } from '@/services/premium-book-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import { describe, expect, it, jest } from '@jest/globals';
import { OrderProofRequest } from '@/services/order-proof.js';
import {
  defaultPremiumSpreadTextBoxes,
  lowerPremiumSpreadTextBoxes,
} from '@/services/premium-book-artwork.js';
import {
  assertSquareCasewrap,
  renderSquarePdf,
  squarePackage,
  validatePremiumManifest,
} from '@/services/premium-order-proof.js';

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
    expect(() => assertSquareCasewrap({ width: 1100, height: 738 })).toThrow();
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
});
