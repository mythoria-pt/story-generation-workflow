import type { Bucket } from '@google-cloud/storage';
import { PDFDocument } from 'pdf-lib';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrintService } from '@/services/print.js';
import { PrintQualityService } from '@/services/print-quality.js';
import { StoryService } from '@/services/story.js';
import { CMYKConversionService } from '@/services/cmyk-conversion.js';
import { renderOrderProof, OrderProofRequest } from '@/services/order-proof.js';
import { premiumInvitationManifestFixture } from './fixtures/premium-book.js';
import { squarePackage } from '@/services/premium-order-proof.js';
import * as squareProof from '@/services/premium-order-proof.js';

function storageFixture() {
  const objects = new Map<string, Buffer>();
  const bucket = {
    name: 'private-test-proofs',
    file: (key: string) => ({
      download: async () => {
        if (!objects.has(key)) throw Object.assign(new Error(), { code: 404 });
        return [objects.get(key)];
      },
      save: async (
        content: string | Buffer,
        options: { preconditionOpts: { ifGenerationMatch: number } },
      ) => {
        expect(options.preconditionOpts.ifGenerationMatch).toBe(0);
        if (objects.has(key)) throw Object.assign(new Error(), { code: 412 });
        objects.set(key, Buffer.from(content));
      },
      getMetadata: async () => [{ generation: '123', size: objects.get(key)?.length }],
    }),
  } as unknown as Bucket;
  return { objects, bucket };
}
const ids = () => ({
  storyId: randomUUID(),
  orderId: randomUUID(),
  runId: randomUUID(),
  provider: 'manual' as const,
  binding: 'paperback' as const,
});
const loadArtwork = jest.fn(async (url: string) => ({
  bytes: Buffer.from(url),
  contentType: 'image/png',
}));
afterEach(() => jest.restoreAllMocks());
describe('paid order PDF generations', () => {
  it('returns the whole square manual proof in one call and reuses it on retry', async () => {
    const manifest = premiumInvitationManifestFixture();
    const premium = storageFixture();
    const proofs = storageFixture();
    const key = `${manifest.storyId}/premium/revisions/${manifest.revision}/manifest.json`;
    const bytes = Buffer.from(JSON.stringify(manifest));
    premium.objects.set(key, bytes);
    const request = OrderProofRequest.parse({
      ...ids(),
      storyId: manifest.storyId,
      binding: 'hardcover',
      premiumPageCount: 33,
      premiumBook: {
        version: 1,
        type: 'premium_children',
        state: 'published',
        revision: manifest.revision,
        manifest: {
          key,
          generation: '123',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
    const square = jest
      .spyOn(squareProof, 'renderSquarePdf')
      .mockImplementation(async (_book, _dir, part) => ({
        bytes: Buffer.from(part),
        issues: [],
      }));
    const result = await renderOrderProof(proofs.bucket, request, loadArtwork, premium.bucket);
    expect(result).toMatchObject({
      qaPassed: true,
      pageCount: 33,
      interior: { object: expect.stringContaining('/manual/hardcover/') },
      cover: { object: expect.stringContaining('/manual/hardcover/') },
    });
    expect(await renderOrderProof(proofs.bucket, request, loadArtwork, premium.bucket)).toEqual(
      result,
    );
    const otherRevision = randomUUID();
    const changed = OrderProofRequest.parse({
      ...request,
      provider: 'lulu',
      podPackageId: squarePackage,
      premiumBook: {
        ...request.premiumBook,
        revision: otherRevision,
        manifest: {
          ...request.premiumBook?.manifest,
          key: key.replace(manifest.revision, otherRevision),
        },
      },
    });
    await expect(
      renderOrderProof(proofs.bucket, changed, loadArtwork, premium.bucket),
    ).rejects.toThrow('already pinned');
    const historical = storageFixture();
    historical.objects.set(
      `print-orders/${request.orderId}/${request.runId}/lulu/hardcover/${request.storyId}/premium-source.json`,
      Buffer.from(JSON.stringify(request.premiumBook)),
    );
    const changedManual = OrderProofRequest.parse({
      ...changed,
      provider: 'manual',
      podPackageId: undefined,
    });
    await expect(
      renderOrderProof(historical.bucket, changedManual, loadArtwork, premium.bucket),
    ).rejects.toThrow('already pinned');
    expect(square.mock.calls.map((call) => call[2])).toEqual(['interior', 'cover']);
  });

  it('passes Lulu cover dimensions and lulu flattening flag for square Lulu proofs and rejects dimension drift', async () => {
    const manifest = premiumInvitationManifestFixture();
    const premium = storageFixture();
    const proofs = storageFixture();
    const key = `${manifest.storyId}/premium/revisions/${manifest.revision}/manifest.json`;
    const bytes = Buffer.from(JSON.stringify(manifest));
    premium.objects.set(key, bytes);
    const request = OrderProofRequest.parse({
      ...ids(),
      storyId: manifest.storyId,
      provider: 'lulu',
      binding: 'hardcover',
      podPackageId: squarePackage,
      premiumPageCount: 33,
      coverDimensions: { width: 1368.2, height: 738 },
      premiumBook: {
        version: 1,
        type: 'premium_children',
        state: 'published',
        revision: manifest.revision,
        manifest: {
          key,
          generation: '123',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
    const square = jest
      .spyOn(squareProof, 'renderSquarePdf')
      .mockImplementation(async (_book, _dir, part) => ({
        bytes: Buffer.from(part),
        issues: [],
      }));
    const result = await renderOrderProof(proofs.bucket, request, loadArtwork, premium.bucket);
    expect(result.qaPassed).toBe(true);
    expect(square).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(String),
      'interior',
      expect.any(Function),
      loadArtwork,
      { coverDimensions: { width: 1368.2, height: 738 }, lulu: true },
    );
    expect(square).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.any(String),
      'cover',
      expect.any(Function),
      loadArtwork,
      { coverDimensions: { width: 1368.2, height: 738 }, lulu: true },
    );
    await expect(
      renderOrderProof(
        proofs.bucket,
        { ...request, coverDimensions: { width: 1370, height: 738 } },
        loadArtwork,
        premium.bucket,
      ),
    ).rejects.toThrow('different dimensions');
  });

  it('stops before rendering if the pinned premium edition differs from the paid interior count', async () => {
    const manifest = premiumInvitationManifestFixture();
    const premium = storageFixture();
    const proofs = storageFixture();
    const key = `${manifest.storyId}/premium/revisions/${manifest.revision}/manifest.json`;
    const bytes = Buffer.from(JSON.stringify(manifest));
    premium.objects.set(key, bytes);
    const request = OrderProofRequest.parse({
      ...ids(),
      storyId: manifest.storyId,
      provider: 'lulu',
      binding: 'hardcover',
      podPackageId: squarePackage,
      premiumPageCount: 32,
      premiumBook: {
        version: 1,
        type: 'premium_children',
        state: 'published',
        revision: manifest.revision,
        manifest: {
          key,
          generation: '123',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
    await expect(
      renderOrderProof(proofs.bucket, request, loadArtwork, premium.bucket),
    ).rejects.toThrow('page count differs from the paid edition');
    expect([...proofs.objects.keys()].every((object) => !object.endsWith('.pdf'))).toBe(true);
  });
  it('rejects arbitrary storage paths or a caller-supplied PDF URL', () => {
    expect(OrderProofRequest.safeParse({ ...ids(), storyId: '../shared' }).success).toBe(false);
    expect(OrderProofRequest.safeParse({ ...ids(), pdfUrl: 'https://example.org' }).success).toBe(
      false,
    );
    expect(
      OrderProofRequest.safeParse({ ...ids(), coverDimensions: { width: 900, height: 620 } })
        .success,
    ).toBe(false);
  });
  it('elects the same final pair for concurrent and repeated prepares, isolating later revisions', async () => {
    const { objects, bucket } = storageFixture();
    const request = ids();
    const fixture = await PDFDocument.create();
    fixture.addPage();
    fixture.addPage();
    const source = {
      storyId: request.storyId,
      chapters: [{ title: 'Start' }],
      title: 'Test',
      coverUri: 'test.png',
    };
    const getStory = jest
      .spyOn(StoryService.prototype, 'getStoryForPrint')
      .mockResolvedValue(source as never);
    jest
      .spyOn(PrintService.prototype, 'generateInteriorVariant')
      .mockImplementation(async (_story, path) => {
        await writeFile(path, await fixture.save());
        return {
          interiorPdfPath: path,
          interiorHtml: '',
          interiorPreProcessedPdfPath: path,
          interiorPostProcessedPdfPath: path,
          imagePageNumbers: [],
        };
      });
    jest
      .spyOn(PrintService.prototype, 'convertInteriorToCMYK')
      .mockImplementation(async (path) => path);
    jest.spyOn(PrintService.prototype, 'generateInteriorHTML').mockReturnValue('');
    jest.spyOn(PrintService.prototype, 'generateCoverHTML').mockReturnValue('');
    jest.spyOn(PrintService.prototype, 'renderPDF').mockImplementation(async (_html, options) => {
      const cover = await PDFDocument.create();
      cover.setTitle(randomUUID());
      cover.addPage();
      await writeFile(options.outputPath, await cover.save());
    });
    jest
      .spyOn(CMYKConversionService.prototype, 'convertToCMYK')
      .mockImplementation(async (options) => {
        await writeFile(options.outputPath, await readFile(options.inputPath));
        return options.outputPath;
      });
    const qa = jest
      .spyOn(PrintQualityService.prototype, 'runDeterministicChecks')
      .mockResolvedValue({ criticalErrors: [] } as never);
    const [a, b] = await Promise.all([
      renderOrderProof(bucket, request, loadArtwork),
      renderOrderProof(bucket, request, loadArtwork),
    ]);
    expect(a).toEqual(b);
    expect(a.qaPassed).toBe(true);
    expect(a.pageCount).toBe(2);
    const cover = a.cover!;
    expect(createHash('sha256').update(objects.get(cover.object)!).digest('hex')).toBe(
      cover.sha256,
    );
    getStory.mockClear();
    qa.mockClear();
    loadArtwork.mockClear();
    expect(await renderOrderProof(bucket, request, loadArtwork)).toEqual(a);
    expect(getStory).not.toHaveBeenCalled();
    expect(qa).not.toHaveBeenCalled();
    expect(loadArtwork).not.toHaveBeenCalled();
    qa.mockResolvedValue({ criticalErrors: [{ code: 'unexpected_blank_page' }] } as never);
    const revised = await renderOrderProof(
      bucket,
      { ...request, runId: randomUUID() },
      loadArtwork,
    );
    expect(revised.qaPassed).toBe(false);
    expect(revised.qaCriticalCount).toBe(1);
    expect(revised.cover?.object).not.toBe(cover.object);
    expect(await renderOrderProof(bucket, request, loadArtwork)).toEqual(a);
  });
});
