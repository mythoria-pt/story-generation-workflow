import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';
import { generatePremiumImage } from '@/services/premium-book-ai.js';
import { premiumManifest, premiumRevisionPrefix } from '@/services/premium-book-contract.js';
import { isPremiumMotifArtwork, selectPremiumOpeningMotif } from '@/services/premium-book-motif.js';
import {
  premiumDigest,
  readPremiumObject,
  savePremiumImage,
} from '@/services/premium-book-storage.js';
import { premiumInvitationManifestFixture } from './fixtures/premium-book.js';
import { fixtureBucket } from './fixtures/premium-storage.js';

jest.mock('@/services/premium-book-ai.js', () => ({ generatePremiumImage: jest.fn() }));
const provider = jest.mocked(generatePremiumImage);

const boatPath =
  '<path d="M232 560H792L690 689H320ZM340 560 510 340 665 560M510 340V560" fill="none" stroke="#285957" stroke-width="19"/>';
function svgFixture(paths: string) {
  return sharp(
    Buffer.from(
      `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

async function setup() {
  const book = premiumInvitationManifestFixture();
  const { storyId, ownerId, revision, config, inputHash } = book;
  const storage = fixtureBucket();
  const { bucket } = storage;
  const prefix = premiumRevisionPrefix(storyId, revision);
  const illustration = await sharp({
    create: { width: 960, height: 480, channels: 3, background: 'lightblue' },
  })
    .png()
    .toBuffer();
  const spread = await savePremiumImage(bucket, prefix, illustration, 'png');
  const input = {
    bucket,
    prefix,
    scope: { storyId, ownerId, revision },
    bookInputHash: inputHash,
    config,
    spread,
    brief: 'Folded paper boat with deep teal seams.',
    guide: 'Restrained watercolor, with sea-glass blue and red-brown ink.',
    background: '#e1f0eb',
  };
  return { book, storage, input, prefix };
}

beforeEach(() => provider.mockReset());

describe('premium illustrated opening motif', () => {
  it('rejects a white patch, opaque canvas, blank, clipped, undersized and malformed motifs', async () => {
    const valid = await svgFixture(boatPath);
    expect(await isPremiumMotifArtwork(valid)).toBe(true);
    const candidates = await Promise.all([
      svgFixture('<rect x="150" y="180" width="725" height="650" fill="white"/>' + boatPath),
      svgFixture('<rect width="1024" height="1024" fill="white"/>' + boatPath),
      svgFixture(''),
      svgFixture(boatPath.replace('<path ', '<path transform="translate(-230,0)" ')),
      svgFixture(boatPath.replace('<path ', '<path transform="translate(470,400) scale(.07)" ')),
      sharp(valid).resize(256, 256).png().toBuffer(),
    ]);
    for (const bytes of [...candidates, Buffer.from('not an image')]) {
      expect(await isPremiumMotifArtwork(bytes)).toBe(false);
    }
  });

  it('makes one low-quality request with the referenced illustration and reuses the pinned exact bytes', async () => {
    const { book, input } = await setup();
    const pixels = await svgFixture(boatPath);
    provider.mockResolvedValue(pixels);
    const reference = await selectPremiumOpeningMotif(input);
    if (!reference) throw new Error('Missing elected art');
    expect(await selectPremiumOpeningMotif(input)).toEqual(reference);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(
      input.scope,
      { ...input.config, quality: 'low' },
      'opening_motif',
      expect.stringContaining('Avoid a background patch'),
      '1024x1024',
      [expect.any(Buffer)],
    );
    const artwork = provider.mock.calls[0]?.[5][0];
    if (!artwork) throw new Error('Missing resized reference');
    expect(await sharp(artwork).metadata()).toMatchObject({
      format: 'jpeg',
      width: 768,
      height: 384,
    });
    expect(reference.sha256).toBe(premiumDigest(pixels));
    expect(await readPremiumObject(input.bucket, reference)).toEqual(pixels);
    const openingDesign = { motif: 'paper_boat', background: input.background };
    expect(
      premiumManifest.parse({ ...book, openingDesign, motifArtwork: reference }).motifArtwork,
    ).toEqual(reference);
    expect(premiumManifest.safeParse({ ...book, motifArtwork: reference }).success).toBe(false);
    expect(
      premiumManifest.safeParse({
        ...book,
        openingDesign,
        motifArtwork: { ...reference, key: reference.key.replace('.png', '.jpg') },
      }).success,
    ).toBe(false);
  });

  it.each(['provider_rejected', 'invalid_art'] as const)(
    'persists curated fallback for %s without a second request',
    async (failure) => {
      const { input, storage, prefix } = await setup();
      if (failure === 'provider_rejected')
        provider.mockRejectedValue(new Error('provider blocked'));
      else provider.mockResolvedValue(await svgFixture(''));
      expect(await selectPremiumOpeningMotif(input)).toBeUndefined();
      expect(await selectPremiumOpeningMotif(input)).toBeUndefined();
      expect(provider).toHaveBeenCalledTimes(1);
      const result = storage.objects.get(`${prefix}/checkpoints/opening-motif.json`);
      expect(JSON.parse(result?.bytes.toString('utf8') ?? '{}')).toMatchObject({ asset: null });
    },
  );

  it('waits on a live election and does not consume a second attempt after losing the result on storage failure', async () => {
    const { input, storage, prefix } = await setup();
    const pixels = await svgFixture(boatPath);
    let reportStarted = () => {};
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let letFinish = () => {};
    const finish = new Promise<void>((resolve) => {
      letFinish = resolve;
    });
    provider.mockImplementation(async () => {
      reportStarted();
      await finish;
      return pixels;
    });
    const pending = selectPremiumOpeningMotif(input);
    const receipt = expect(pending).rejects.toMatchObject({ code: 500 });
    await started;
    try {
      await expect(selectPremiumOpeningMotif(input)).rejects.toMatchObject({
        code: 'premium_stage_busy',
      });
      storage.failNextSave(`${prefix}/checkpoints/opening-motif.json`, 500);
    } finally {
      letFinish();
    }
    await receipt;
    expect(await selectPremiumOpeningMotif(input)).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
