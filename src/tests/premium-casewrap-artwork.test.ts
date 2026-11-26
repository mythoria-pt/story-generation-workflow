import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';
import { extendPremiumCasewrapArtwork } from '@/services/premium-casewrap-artwork.js';

describe('premium casewrap artwork extension', () => {
  it('softens edge colors without carrying interior cover lettering into the wrap', async () => {
    const size = 96;
    const channels = 3;
    const width = 108;
    const height = 146;
    const left = (width - size) / 2;
    const top = (height - size) / 2;
    const pixels = Buffer.alloc(size * size * channels, 180);
    for (let x = 0; x < size; x++) {
      pixels.fill(x % 2 === 0 ? 100 : 220, x * channels, (x + 1) * channels);
    }
    for (let y = 8; y < 20; y++) {
      pixels.fill(0, (y * size + 20) * channels, (y * size + 76) * channels);
    }

    const source = await sharp(pixels, { raw: { width: size, height: size, channels } })
      .png()
      .toBuffer();
    const extended = await extendPremiumCasewrapArtwork(source, size, width, height);
    const panel = sharp(extended);
    expect(await panel.metadata()).toMatchObject({ width, height, format: 'png', hasAlpha: false });
    const trimmed = await panel
      .clone()
      .extract({ left, top, width: size, height: size })
      .raw()
      .toBuffer();
    expect(trimmed.equals(pixels)).toBe(true);

    const wrap = await panel.raw().toBuffer();
    const sample = (x: number, y: number) => wrap[(y * width + x) * channels]!;
    expect(sample(left + 40, top - 10)).toBeGreaterThan(130);
    expect(Math.abs(sample(left + 40, 0) - sample(left + 41, 0))).toBeLessThan(20);
  });
});
