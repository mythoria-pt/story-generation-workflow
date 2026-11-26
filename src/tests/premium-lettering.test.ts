import { afterEach, describe, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import {
  reviewPremiumDesignCover,
  reviewPremiumLetteredArtwork,
  reviewPremiumLetteredGuide,
} from '@/services/premium-book-ai.js';
import {
  createPremiumBlankTile,
  createPremiumNativeSpreadGuides,
  exportIndependentPremiumSpread,
  exportNativePremiumSpread,
  exportPremiumArtwork,
  PREMIUM_PRINT_PPI,
  readPremiumPrintPageTrim,
  restoreIndependentPremiumTile,
} from '@/services/premium-book-artwork.js';
import {
  buildPremiumDesignCoverPrompt,
  buildPremiumLetteredPagePrompt,
  buildPremiumLetteredPanoramaPrompt,
  premiumLetteredPageReferences,
} from '@/services/premium-book-lettering.js';

const scope = { storyId: 'story', ownerId: 'owner', revision: 'revision' };
const config = { provider: 'google-genai' as const, model: 'gemini-4-hydrogen' };
const passed = {
  coherentArtwork: true,
  consistentCharacters: true,
  typography: {
    readableLettering: 'none',
    safeLettering: 'none',
    childlikeLettering: 'none',
  },
  childlikeArtwork: true,
  safeGutter: true,
  safeTrim: true,
};

const image = (width: number, height: number, background = '#fadca8') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

describe('independent premium lettering review', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects unsafe bounds, a lost acute accent and the wrong action target on the affected page', async () => {
    const proofScope = { ...scope, artDirectionVersion: 1 as const };
    const sample = await image(32, 32);
    const complete = jest.spyOn(GoogleGenAITextService.prototype, 'complete');
    const scene =
      'Visible cast: Bea and her grandfather’s hand. The grandfather offers the tiny monkey at Bea’s nose, the only face. His hand holds a banana.';
    const narration = 'O macaco era minúsculo.';
    const accepted = {
      ...passed,
      leftTranscription: '',
      rightTranscription: narration,
      letteringBounds: {
        left: null,
        right: { left: 0.12, top: 0.12, right: 0.88, bottom: 0.54 },
      },
      sceneActionAccurate: true,
    };
    const artwork = {
      source: sample,
      pages: [{ side: 'right' as const, text: narration, trim: sample }],
      reference: sample,
      scene,
    };
    complete.mockResolvedValueOnce(JSON.stringify(accepted));
    await expect(
      reviewPremiumLetteredArtwork(proofScope, config, 'spread-8', artwork),
    ).resolves.toBeUndefined();
    expect(complete.mock.calls[0]?.[0]).toContain(
      'the named actor performs the action on the precise target',
    );
    expect(complete.mock.calls[0]?.[0]).not.toContain(narration);

    complete.mockResolvedValueOnce(
      JSON.stringify({
        ...accepted,
        rightTranscription: 'O macaco era minusculo.',
        sceneActionAccurate: false,
        letteringBounds: {
          left: null,
          right: { ...accepted.letteringBounds.right, top: 0.119 },
        },
      }),
    );
    await expect(
      reviewPremiumLetteredArtwork(proofScope, config, 'spread-8', artwork),
    ).rejects.toMatchObject({
      failedChecks: ['sceneActionAccurate', 'safeLettering', 'exactLettering'],
      failedLetteringSides: ['right'],
    });
  });

  it('rejects a front-title flourish inside the headroom even when all title words match', async () => {
    const sample = await image(32, 32);
    const complete = jest.spyOn(GoogleGenAITextService.prototype, 'complete');
    complete.mockResolvedValueOnce(
      JSON.stringify({
        transcription: 'Bea e o Macaco no Nariz',
        coherentArtwork: true,
        safeComposition: true,
        childlikeArtwork: true,
        readableLettering: true,
        sceneActionAccurate: true,
        letteringBounds: { left: 0.24, top: 0.11, right: 0.82, bottom: 0.42 },
      }),
    );
    await expect(
      reviewPremiumDesignCover(
        { ...scope, artDirectionVersion: 1 },
        config,
        'front',
        sample,
        sample,
        'Bea holds out a banana.',
        'Bea e o Macaco no Nariz',
      ),
    ).rejects.toMatchObject({ failedChecks: ['safeLettering'] });
    expect(complete.mock.calls[0]?.[0]).toContain('decorative capital strokes');
  });

  it('rejects a panorama missing its carried case and asks for a revised scene with room at the fold', async () => {
    const sample = await image(32, 32);
    const complete = jest.spyOn(GoogleGenAITextService.prototype, 'complete');
    const replacementScene =
      'Keep sky continuous and move the grandfather and his strapped brown case far right.';
    complete.mockResolvedValueOnce(
      JSON.stringify({
        coherentArtwork: true,
        safeGutter: false,
        sceneActionAccurate: false,
        replacementScene,
      }),
    );
    await expect(
      reviewPremiumLetteredGuide(
        { ...scope, artDirectionVersion: 1 },
        config,
        'spread-6',
        sample,
        sample,
        undefined,
        {
          action:
            'The grandfather parachutes carrying the same brown case attached by his shoulder strap.',
        },
      ),
    ).rejects.toMatchObject({
      failedChecks: ['safeGutter', 'sceneActionAccurate'],
      replacementScene,
    });
    expect(complete.mock.calls[0]?.[0]).toContain('complete silhouettes of essential figures');
    expect(complete.mock.calls[0]?.[0]).toContain('brown case attached by his shoulder strap');
  });

  it('keeps the hippo alone when the shared guide and narration mention a lion', () => {
    const guide = 'Papercut. The recurring lion has a golden mane and the hippo has lilac skin.';
    const action = 'One lilac hippo stands alone in the shallow water.';
    const prompts = [
      buildPremiumDesignCoverPrompt({
        side: 'front',
        title: 'O leão que ouviu o rio',
        locale: 'pt-PT',
        guide,
        scene: action,
        correction: false,
      }),
      buildPremiumLetteredPanoramaPrompt({ action, guide, generationDesignVersion: 1 }),
      buildPremiumLetteredPagePrompt({
        side: 'left',
        action,
        guide,
        text: 'Até o leão ouviu o seu chapinhar.',
        independent: { hasPrior: false, hasNeighbour: true },
        generationDesignVersion: 1,
      }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('The recurring lion');
      expect(prompt).toContain(action);
      expect(prompt).toContain('If it calls for one character, show that character alone.');
      expect(prompt).toContain(
        'A character named or shown only in the title, narration, shared guide or references stays out of the scene.',
      );
    }
  });

  it('preserves the exact accented title on the front and keeps the back art wordless', async () => {
    const title = 'É o céu, avó!';
    const scene = 'A child looks through a window at a quiet night sky.';
    const guide = 'Paper collage with muted blues.';
    const front = buildPremiumDesignCoverPrompt({
      side: 'front',
      title,
      scene,
      guide,
      locale: 'pt-PT',
      correction: false,
    });
    const back = buildPremiumDesignCoverPrompt({
      side: 'back',
      title,
      scene,
      guide,
      locale: 'pt-PT',
      correction: false,
    });
    expect(front).toContain(`<title>\n${title}\n</title>`);
    expect(front).toContain('only the characters, location features and objects called for');
    expect(back).not.toContain(title);
    expect(back).toContain('lower-left safe area');

    const sample = await image(32, 32);
    const checks = {
      coherentArtwork: true,
      childlikeArtwork: true,
      safeComposition: true,
      readableLettering: true,
    };
    const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete');
    reviewer.mockResolvedValueOnce(
      JSON.stringify({ ...checks, transcription: 'É o céu,\n  avó!' }),
    );
    await expect(
      reviewPremiumDesignCover(scope, config, 'front', sample, sample, scene, title),
    ).resolves.toBeUndefined();
    expect(reviewer.mock.calls[0]?.[0]).not.toContain(title);
    reviewer.mockResolvedValueOnce(JSON.stringify({ ...checks, transcription: 'É o céu, avo!' }));
    await expect(
      reviewPremiumDesignCover(scope, config, 'front', sample, sample, scene, title),
    ).rejects.toMatchObject({ failedChecks: ['exactLettering'] });
    reviewer.mockResolvedValueOnce(JSON.stringify({ ...checks, transcription: 'SIGN' }));
    await expect(
      reviewPremiumDesignCover(scope, config, 'back', sample, sample, scene, title),
    ).rejects.toMatchObject({ failedChecks: ['noLettering'] });
  });

  it('checks original panorama continuity and binding before native page rendering', async () => {
    const panorama = await image(204, 104);
    const cast = await image(104, 104, 'ivory');
    const action = 'A rabbit sets a red cup on the table, then fills it from a jug.';
    const leftDescription = 'Une tasse rouge est posée sur la table.';
    const replacementScene =
      'From table height show the rabbit holding the jug at right, with the red cup already on the table at left.';
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValueOnce(
        JSON.stringify({ coherentArtwork: false, safeGutter: true, replacementScene }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ coherentArtwork: true, safeGutter: false, replacementScene }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ coherentArtwork: true, safeGutter: true, replacementScene: '' }),
      );
    const review = () =>
      reviewPremiumLetteredGuide(scope, config, 'spread-1', panorama, cast, undefined, {
        action,
        leftDescription,
      });
    await expect(review()).rejects.toMatchObject({
      failedChecks: ['coherentArtwork'],
      replacementScene,
    });
    await expect(review()).rejects.toMatchObject({
      failedChecks: ['safeGutter'],
      replacementScene,
    });
    await expect(review()).resolves.toBeUndefined();
    const [prompt, options] = reviewer.mock.calls[0] ?? [];
    expect(prompt).toContain('repeated physical depictions');
    expect(prompt).toContain('natural reflection');
    expect(prompt).toContain('middle band from 45% to 55%');
    expect(prompt).toContain(action);
    expect(prompt).toContain(leftDescription);
    expect(options?.mediaParts).toHaveLength(2);
  });

  it('reduces successive visual beats to one scene in the panorama prompt', () => {
    const action = 'A rabbit sets a red cup on the table, then fills it from a jug.';
    const prompt = buildPremiumLetteredPanoramaPrompt({
      action,
      guide: 'Soft pencil and warm paper.',
    });
    expect(prompt).toContain('choose one drawable instant in one coherent setting');
    expect(prompt).toContain('Show each physical character and distinctive story prop only once');
    expect(prompt).toContain('A natural reflection is allowed');
    expect(prompt).toContain(action);
  });

  it('uses actual page crops and accepts only natural breaks in exact canonical narration', async () => {
    const expected = 'Só falta o grande espelho dourado!';
    const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
      JSON.stringify({
        ...passed,
        leftTranscription: '',
        rightTranscription: 'So\u0301 falta o grande\nespelho dourado!',
      }),
    );
    const source = await image(400, 200);
    const left = await image(200, 200, '#93d8c3');
    const right = await image(200, 200, '#c5a3e8');
    await expect(
      reviewPremiumLetteredArtwork(scope, config, 'spread-1', {
        source,
        pages: [
          { side: 'left', text: '', trim: left },
          { side: 'right', text: expected, trim: right },
        ],
        reference: source,
      }),
    ).resolves.toBeUndefined();
    expect(reviewer.mock.calls[0]?.[0]).not.toContain(expected);
    expect(reviewer.mock.calls[0]?.[1]?.mediaParts).toHaveLength(4);
    const media = reviewer.mock.calls[0]?.[1]?.mediaParts ?? [];
    expect(media[1]?.data).not.toEqual(media[2]?.data);
    expect(reviewer.mock.calls[0]?.[0]).toContain('separately repeated on both panels');
  });

  it.each([
    ['So falta o espelho!', '', 'none', 'exactLettering'],
    ['Só falta o espelho.', '', 'none', 'exactLettering'],
    ['Só falta o espelho!', '7', 'none', 'exactLettering'],
    ['Só falta o espelho!', '', 'right', 'safeLettering'],
  ] as const)(
    'rejects a failed page comparison or placement review',
    async (right, left, safeLettering, failure) => {
      jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
        JSON.stringify({
          ...passed,
          typography: { ...passed.typography, safeLettering },
          leftTranscription: left,
          rightTranscription: right,
        }),
      );
      const source = await image(100, 100);
      await expect(
        reviewPremiumLetteredArtwork(scope, config, 'opener', {
          source,
          pages: [{ side: 'right', text: 'Só falta o espelho!', trim: source }],
          reference: source,
        }),
      ).rejects.toMatchObject({ failedChecks: [failure] });
    },
  );

  it.each([
    ['right', ['right']],
    ['unknown', ['left', 'right']],
  ] as const)(
    'rejects unsafe right-page lettering and applies location %s conservatively',
    async (location, sides) => {
      const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
        JSON.stringify({
          ...passed,
          typography: { ...passed.typography, safeLettering: location },
          leftTranscription: '',
          rightTranscription: '¡Buenas noches!',
        }),
      );
      const source = await image(100, 100);
      await expect(
        reviewPremiumLetteredArtwork(scope, config, 'spread-1', {
          source,
          pages: [
            { side: 'left', text: '', trim: source },
            { side: 'right', text: '¡Buenas noches!', trim: source },
          ],
          reference: source,
        }),
      ).rejects.toMatchObject({
        failedChecks: ['safeLettering'],
        failedLetteringSides: sides,
        failedLetteringChecksBySide: {
          left: location === 'unknown' ? ['safeLettering'] : [],
          right: ['safeLettering'],
        },
      });
      expect(reviewer.mock.calls[0]?.[0]).toContain('including the top of the first line');
    },
  );

  it('keeps distinct readability and lettering-style findings scoped to their reported pages', async () => {
    const source = await image(100, 100);
    jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
      JSON.stringify({
        ...passed,
        typography: {
          ...passed.typography,
          readableLettering: 'left',
          childlikeLettering: 'right',
        },
        leftTranscription: 'Bonjour !',
        rightTranscription: 'À demain !',
      }),
    );
    await expect(
      reviewPremiumLetteredArtwork(scope, config, 'spread-1', {
        source,
        pages: [
          { side: 'left', text: 'Bonjour !', trim: source },
          { side: 'right', text: 'À demain !', trim: source },
        ],
        reference: source,
      }),
    ).rejects.toMatchObject({
      failedChecks: ['readableLettering', 'childlikeLettering'],
      failedLetteringSides: ['left', 'right'],
      failedLetteringChecksBySide: { left: ['readableLettering'], right: ['childlikeLettering'] },
    });
  });

  it('gives exact page text to the artist and keeps the silent page unlettered', () => {
    const scene = {
      action: 'A fox watches a firefly.',
      guide: 'Warm realistic illustration.',
      facing: true,
    };
    const narrated = buildPremiumLetteredPagePrompt({
      ...scene,
      side: 'right',
      text: 'Là, une luciole !',
      audience: 'children_3-6',
      locale: 'fr-FR',
    });
    expect(narrated).toContain('<narration>\nLà, une luciole !\n</narration>');
    expect(narrated).toContain('warm, childlike hand lettering');
    expect(narrated).toContain('For ages 3–6');
    expect(narrated).toContain('fr-FR');
    expect(narrated).not.toContain(scene.action);
    expect(narrated).not.toContain(scene.guide);
    const silent = buildPremiumLetteredPagePrompt({
      ...scene,
      side: 'left',
      text: '',
      audience: 'children_0-2',
    });
    expect(silent).toContain('The page is silent');
    expect(silent).toContain('For ages 0–2');
    expect(silent).not.toContain('<narration>');
  });

  it('keeps absent characters out of facing references and uses the cast for standalone pages', () => {
    const cast = Buffer.from('whole cast including the fox');
    const guideCrop = Buffer.from('cropped setting with no fox');
    expect(premiumLetteredPageReferences(cast, guideCrop)).toEqual([guideCrop]);
    expect(premiumLetteredPageReferences(cast)).toEqual([cast]);
    expect(
      buildPremiumLetteredPagePrompt({
        side: 'right',
        text: 'Bonsoir !',
        action: 'The fox lies down.',
        guide: 'Ink and washes.',
      }),
    ).toContain('The fox lies down.');
  });

  it('rejects a photographic visual review even when the embedded lettering is exact', async () => {
    const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
      JSON.stringify({
        ...passed,
        childlikeArtwork: false,
        leftTranscription: '',
        rightTranscription: '¡Buenas noches!',
      }),
    );
    const source = await image(100, 100);
    await expect(
      reviewPremiumLetteredArtwork(scope, config, 'opener', {
        source,
        pages: [{ side: 'right', text: '¡Buenas noches!', trim: source }],
        reference: source,
      }),
    ).rejects.toMatchObject({ failedChecks: ['childlikeArtwork'] });
    expect(reviewer.mock.calls[0]?.[0]).toContain('Reject a photographic or live-action look');
    expect(reviewer.mock.calls[0]?.[0]).toContain('Illustrated realism can pass');
  });

  it('checks a paired illustration as its own scene with the facing page as continuity reference', async () => {
    const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
      JSON.stringify({
        ...passed,
        leftTranscription: 'Outra vez, Leonor!',
        rightTranscription: '',
        pageDescriptionAccurate: true,
        pairedContinuity: false,
      }),
    );
    const source = await image(100, 100);
    const neighbour = await image(100, 100, '#d1dee9');
    await expect(
      reviewPremiumLetteredArtwork(scope, config, 'spread-1-left', {
        source,
        pages: [{ side: 'left', text: 'Outra vez, Leonor!', trim: source }],
        reference: source,
        independent: { side: 'left', description: 'Leonor waves to the boat.', neighbour },
      }),
    ).rejects.toMatchObject({ failedChecks: ['pairedContinuity'] });
    expect(reviewer.mock.calls[0]?.[0]).toContain('Leonor waves to the boat.');
    expect(reviewer.mock.calls[0]?.[0]).not.toContain('Outra vez, Leonor!');
    expect(reviewer.mock.calls[0]?.[1]?.mediaParts).toHaveLength(4);
  });

  it('isolates independent page prompts from combined spread actions and preserves margin cues', () => {
    const base = {
      side: 'left' as const,
      text: 'Bom dia!',
      action: 'A fox walks along the harbour path.',
      guide: 'Soft watercolour.',
      audience: 'children_3-6' as const,
    };
    const initial = buildPremiumLetteredPagePrompt({
      ...base,
      independent: { hasPrior: false, hasNeighbour: false },
    });
    expect(initial).toContain('leaving at least 12% empty margin from every edge');
    expect(initial).toContain('empty band of background above the first line');
    expect(initial).not.toContain('Context:');
    const corrected = buildPremiumLetteredPagePrompt({
      ...base,
      independent: {
        correctionInstructions: 'Move the boat further right.',
        hasPrior: true,
        hasNeighbour: true,
      },
    });
    expect(corrected).toContain(
      'Apply this requested correction to this page: Move the boat further right.',
    );
  });

  it('uses the 6% safeLettering threshold and ignores typography findings on the absent facing side', async () => {
    const reviewer = jest.spyOn(GoogleGenAITextService.prototype, 'complete').mockResolvedValue(
      JSON.stringify({
        ...passed,
        typography: { ...passed.typography, safeLettering: 'right' },
        leftTranscription: 'Outra vez, Leonor!',
        rightTranscription: '',
        pageDescriptionAccurate: true,
        pairedContinuity: true,
      }),
    );
    const source = await image(100, 100);
    const neighbour = await image(100, 100, '#d1dee9');
    await expect(
      reviewPremiumLetteredArtwork(scope, config, 'spread-1-left', {
        source,
        pages: [{ side: 'left', text: 'Outra vez, Leonor!', trim: source }],
        reference: source,
        independent: { side: 'left', description: 'Leonor waves to the boat.', neighbour },
      }),
    ).resolves.toBeUndefined();
    expect(reviewer.mock.calls[0]?.[0]).toContain('less than 6% of the trimmed width or height');
  });

  it('distinguishes internal paired briefs from user accessibility descriptions in pageDescriptionAccurate', async () => {
    const reviewer = jest
      .spyOn(GoogleGenAITextService.prototype, 'complete')
      .mockResolvedValueOnce(
        JSON.stringify({
          ...passed,
          leftTranscription: 'Bom dia!',
          rightTranscription: '',
          pageDescriptionAccurate: true,
          pairedContinuity: true,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          ...passed,
          leftTranscription: '',
          rightTranscription: '',
          pageDescriptionAccurate: true,
          pairedContinuity: true,
        }),
      );
    const source = await image(100, 100);
    const neighbour = await image(100, 100, '#d1dee9');
    await reviewPremiumLetteredArtwork(scope, config, 'spread-3-left', {
      source,
      pages: [{ side: 'left', text: 'Bom dia!', trim: source }],
      reference: source,
      independent: {
        side: 'left',
        description: 'Fox walks with backpack.',
        isUserDescription: false,
        neighbour,
      },
    });
    expect(reviewer.mock.calls[0]?.[0]).toContain(
      'Allow reasonable illustrative interpretation of minor props, poses, background layout or staging cues',
    );
    await reviewPremiumLetteredArtwork(scope, config, 'spread-3-left', {
      source,
      pages: [{ side: 'left', text: '', trim: source }],
      reference: source,
      independent: {
        side: 'left',
        description: 'Uma raposa passeia no jardim.',
        isUserDescription: true,
        neighbour,
      },
    });
    expect(reviewer.mock.calls[1]?.[0]).toContain(
      'visibly supports this accessibility description and its essential visual details',
    );
  });

  it('keeps facing panorama tile prompts free of invented characters while standalone preserves them', () => {
    const facingPrompt = buildPremiumLetteredPagePrompt({
      side: 'right',
      text: 'Bom dia!',
      action: 'A sunny clearing.',
      guide: 'Soft watercolour.',
      facing: true,
      audience: 'children_3-6',
    });
    expect(facingPrompt).toContain('For ages 3–6');
    expect(facingPrompt).toContain('leaving at least 12% empty margin from every edge');
    expect(facingPrompt).toContain('empty band of background above the first line');
    expect(facingPrompt).toContain('without adding characters, animals or new foreground elements');
    expect(facingPrompt).not.toContain('place the main characters in the lower two-thirds');
    expect(facingPrompt).not.toContain('make the character’s action instantly clear');

    const standalonePrompt = buildPremiumLetteredPagePrompt({
      side: 'right',
      text: 'Bom dia!',
      action: 'A sunny clearing.',
      guide: 'Soft watercolour.',
      facing: false,
      audience: 'children_3-6',
    });
    expect(standalonePrompt).toContain('place the main characters in the lower two-thirds');
  });
});

describe('premium native print export', () => {
  it('takes the lettering review crop from the print geometry', async () => {
    const bleed = await image(2660, 2660);
    const trim = await readPremiumPrintPageTrim(bleed);
    await expect(sharp(trim).metadata()).resolves.toMatchObject({
      width: 2584,
      height: 2584,
    });
  });
  it('keeps both native independent tiles full-bleed and a hard join between their trims', async () => {
    const left = await createPremiumBlankTile('#ff0000');
    const right = await createPremiumBlankTile('#0000ff');
    const art = await exportIndependentPremiumSpread(left, right);
    expect(await sharp(art.source).metadata()).toMatchObject({
      width: 5244,
      height: 2660,
      hasAlpha: false,
    });
    const center = await sharp(art.source)
      .extract({ left: 2621, top: 1000, width: 2, height: 1 })
      .raw()
      .toBuffer();
    expect([...center]).toEqual([255, 0, 0, 0, 0, 255]);
    for (const file of art.printPages) {
      expect(await sharp(file).metadata()).toMatchObject({ width: 2660, height: 2660 });
    }
    for (const file of art.readingPages) {
      expect(await sharp(file).metadata()).toMatchObject({ width: 816, height: 816 });
    }
    const restored = await restoreIndependentPremiumTile(art.source, 'right');
    expect(await sharp(restored).metadata()).toMatchObject({ width: 2672, height: 2672 });
    expect(await sharp(restored).stats()).toMatchObject({
      channels: [
        { min: 0, max: 0 },
        { min: 0, max: 0 },
        { min: 255, max: 255 },
      ],
    });
  });

  it('keeps a separate low-resolution staging guide and stitches real native page pixels', async () => {
    const panorama = await image(1920, 976);
    const guides = await createPremiumNativeSpreadGuides(panorama);
    for (const guide of guides) {
      expect(await sharp(guide).metadata()).toMatchObject({
        width: 840,
        height: 840,
        format: 'jpeg',
      });
    }
    const page = await image(2672, 2672);
    const art = await exportNativePremiumSpread(page, page);
    expect(art).toMatchObject({
      nativeWidth: 5244,
      nativeHeight: 2660,
      effectivePpi: PREMIUM_PRINT_PPI,
    });
    for (const file of art.printPages) {
      expect(await sharp(file).metadata()).toMatchObject({
        width: 2660,
        height: 2660,
        format: 'jpeg',
      });
    }
    for (const file of art.readingPages) {
      expect(await sharp(file).metadata()).toMatchObject({
        width: 816,
        height: 816,
        format: 'png',
      });
    }
  });

  it('rejects low-density native inputs before any export enlargement', async () => {
    const source = await image(1920, 976);
    await expect(exportPremiumArtwork(source, '1920x976', true, true)).rejects.toMatchObject({
      code: 'premium_native_print_resolution',
    });
    await expect(exportNativePremiumSpread(source, source)).rejects.toMatchObject({
      code: 'premium_native_print_resolution',
    });
  });
});
