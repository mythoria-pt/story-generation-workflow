import { afterEach, describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import { logger } from '@/config/logger.js';
import {
  PremiumArtworkReviewError,
  premiumReviewCheck,
  premiumReviewGuidance,
  reviewPremiumImage,
  reviewPremiumSpreadTextPlacement,
} from '@/services/premium-book-ai.js';

const scope = { storyId: 'story', ownerId: 'owner', revision: 'revision' };
const config = { provider: 'google-genai' as const, model: 'gemini-4-hydrogen' };
const passed = {
  noLettering: true,
  safeComposition: true,
  coherentArtwork: true,
  consistentCharacters: true,
};
const spreadPlacement = { clearTextArea: true, safeGutter: true, safeTrim: true };
const spreadPassed = { ...passed, ...spreadPlacement };

async function picture(background = 'white') {
  return sharp({ create: { width: 160, height: 80, channels: 3, background } })
    .png()
    .toBuffer();
}

describe('premium spread text placement review', () => {
  it('keeps the preferred placement after an accepted review', async () => {
    const review = jest.fn(async () => {});
    await expect(reviewPremiumSpreadTextPlacement(review)).resolves.toBe('top');
    expect(review.mock.calls).toEqual([['top']]);
  });

  it('accepts the lower position after a complete review of that placement succeeds', async () => {
    const review = jest
      .fn(async () => {})
      .mockRejectedValueOnce(new PremiumArtworkReviewError(['clearTextArea']));
    await expect(reviewPremiumSpreadTextPlacement(review)).resolves.toBe('bottom');
    expect(review.mock.calls).toEqual([['top'], ['bottom']]);
  });

  it.each([
    new PremiumArtworkReviewError(['safeGutter']),
    new PremiumArtworkReviewError(['clearTextArea', 'safeTrim']),
    new Error('Review unavailable'),
  ])('propagates %s with no alternate placement', async (error) => {
    const review = jest.fn(async () => {}).mockRejectedValueOnce(error);
    await expect(reviewPremiumSpreadTextPlacement(review)).rejects.toBe(error);
    expect(review.mock.calls).toEqual([['top']]);
  });

  it('propagates the lower review failure and rejects a preferred lower panel only once', async () => {
    const obstructed = new PremiumArtworkReviewError(['clearTextArea']);
    const rejected = new PremiumArtworkReviewError(['consistentCharacters']);
    const review = jest
      .fn(async () => {})
      .mockRejectedValueOnce(obstructed)
      .mockRejectedValueOnce(rejected);
    await expect(reviewPremiumSpreadTextPlacement(review)).rejects.toBe(rejected);
    expect(review.mock.calls).toEqual([['top'], ['bottom']]);

    review.mockClear();
    review.mockRejectedValueOnce(obstructed);
    await expect(reviewPremiumSpreadTextPlacement(review, 'bottom')).rejects.toBe(obstructed);
    expect(review.mock.calls).toEqual([['bottom']]);
  });
});

it('turns persisted centre-line feedback into placement guidance without dropping other checks', () => {
  const checks = premiumReviewCheck.array().parse(['centreLine', 'leftDescriptionAccurate']);
  const guidance = premiumReviewGuidance(checks);
  expect(guidance).toContain('Carry continuous scenery and even lighting across the middle');
  expect(guidance).toContain('Angle physical frames and move their hard vertical edges away');
  expect(guidance).toContain('Avoid a sudden change in color or contrast between halves');
  expect(guidance).toContain(
    'Show all essential details of the left-page description on that page',
  );
});

describe('premium image review', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['references', 'spread-1'])('uses the appropriate criteria for %s', async (phase) => {
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValue(JSON.stringify(phase === 'references' ? passed : spreadPassed));
    const image = await picture();

    await expect(
      reviewPremiumImage(scope, config, phase, image, 'A visual guide', [image], 'Ample space'),
    ).resolves.toBeUndefined();

    const prompt = reviewer.mock.calls[0]![0];
    expect(prompt).toContain('Approve noLettering');
    expect(prompt).toContain('Approve consistentCharacters');
    expect(prompt).toContain('references and guide');
    if (phase === 'references') {
      expect(prompt).toContain('Evaluate safeComposition');
      expect(prompt).toContain('authoritative likeness references');
      expect(prompt).toContain('Intentional spacing or a lineup arrangement is expected');
      expect(prompt).not.toContain('one continuous illustration');
    } else {
      expect(prompt).toContain('one continuous illustration with no artificial diptych seam');
      for (const check of Object.keys(spreadPlacement))
        expect(prompt).toContain(`Approve ${check}`);
      expect(prompt).not.toContain('lineup arrangement is expected');
    }
  });

  it('reviews the untouched panorama and its marked placement copy before the character references', async () => {
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValue(JSON.stringify(spreadPassed));
    const image = await picture();
    const reference = await picture('black');

    await reviewPremiumImage(
      scope,
      config,
      'spread-1',
      image,
      'Guide',
      [reference],
      'Composition',
      undefined,
      {
        textAreas: [{ x: 0.55, y: 0.12, width: 0.4, height: 0.18 }],
        gutter: { x: 0.45, y: 0, width: 0.1, height: 1 },
      },
    );

    const [prompt, options] = reviewer.mock.calls[0]!;
    expect(prompt).toContain('Judge the artwork itself on the unmarked first image');
    expect(prompt).toContain(
      'Any images after the marked copy are authoritative character references',
    );
    const images = options?.mediaParts?.map(({ data }) => data);
    expect(images).toHaveLength(3);
    const [raw, marked, cast] = await Promise.all(
      images!.map((buffer) => sharp(buffer).raw().toBuffer()),
    );
    expect(raw!.every((channel) => channel === 255)).toBe(true);
    expect(cast!.every((channel) => channel === 0)).toBe(true);
    const pixel = (x: number, y: number) => [
      ...marked!.subarray((160 * y + x) * 3, (160 * y + x) * 3 + 3),
    ];
    const [redGutter, , blueGutter] = pixel(80, 40);
    const [redTextArea, , blueTextArea] = pixel(120, 16);
    expect(redGutter).toBeGreaterThan(blueGutter!);
    expect(blueTextArea).toBeGreaterThan(redTextArea!);
    expect(pixel(35, 16)).toEqual([255, 255, 255]);
  });

  it('uses the scene to compare established cast likeness while allowing scene-specific extras', async () => {
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValue(JSON.stringify({ ...spreadPassed, consistentCharacters: false }));
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const scene = 'Ari sets the table while a guest brings a plate.';
    const image = await picture();

    await expect(
      reviewPremiumImage(
        scope,
        config,
        'spread-1',
        image,
        'Ari has red hair.',
        [image],
        'Composition',
        undefined,
        undefined,
        scene,
      ),
    ).rejects.toMatchObject({
      code: 'premium_artwork_review',
      failedChecks: ['consistentCharacters'],
    });

    const [prompt] = reviewer.mock.calls[0]!;
    expect(prompt).toContain(JSON.stringify(scene));
    expect(prompt).toContain(
      'each depicted recurring role with an established appearance matches its likeness',
    );
    expect(prompt).toContain(
      'Scene-specific figures without an established likeness may have distinct original appearances',
    );
  });

  it.each(Object.keys(spreadPlacement))('rejects a spread when %s fails', async (failedCheck) => {
    jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValue(JSON.stringify({ ...spreadPassed, [failedCheck]: false }));
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await expect(
      reviewPremiumImage(
        scope,
        config,
        'spread-1',
        await picture(),
        'Private guide',
        [],
        'Composition',
      ),
    ).rejects.toMatchObject({ code: 'premium_artwork_review', failedChecks: [failedCheck] });
    expect(warning).toHaveBeenCalledWith('Premium visual review rejected artwork', {
      phase: 'spread-1',
      revision: scope.revision,
      failedChecks: [failedCheck],
    });
  });

  it.each(Object.keys(passed) as Array<keyof typeof passed>)(
    'rejects a reference sheet when %s fails and logs only the check name',
    async (failedCheck) => {
      jest
        .spyOn(GoogleGenAITextService.prototype, 'complete')
        .mockResolvedValue(JSON.stringify({ ...passed, [failedCheck]: false }));
      const warning = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const image = await picture();

      await expect(
        reviewPremiumImage(
          scope,
          config,
          'references',
          image,
          'Private guide',
          [image],
          'Ample space',
        ),
      ).rejects.toMatchObject({ code: 'premium_artwork_review' });
      expect(warning).toHaveBeenCalledWith('Premium visual review rejected artwork', {
        phase: 'references',
        revision: scope.revision,
        failedChecks: [failedCheck],
      });
    },
  );

  it.each(['opener', 'ending'])('reviews %s as a standalone square scene', async (phase) => {
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValue(JSON.stringify(passed));
    const image = await picture();
    const composition = 'Keep the upper text area visually quiet';

    await reviewPremiumImage(scope, config, phase, image, 'Guide', [image], composition);

    const prompt = reviewer.mock.calls[0]![0];
    expect(prompt).toContain('single complete square scene');
    expect(prompt).toContain('no panels, inset pictures, borders or folds');
    expect(prompt).toContain(composition);
    expect(prompt).not.toContain('diptych seam');
  });
});
