import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import OpenAI from 'openai';
import { z } from 'zod';
import { generatePremiumImage, generatePremiumText } from '@/services/premium-book-ai.js';
import { premiumManifestFixture } from './fixtures/premium-book.js';

const edit = jest.fn();
const generate = jest.fn();
const complete = jest.fn();
jest.mock('openai', () => {
  class MockAPIError extends Error {
    status: number;
    code: string;
    constructor(status: number, error: { code?: string } | undefined, message: string) {
      super(message);
      this.status = status;
      this.code = error?.code ?? message;
    }
  }
  return {
    __esModule: true,
    default: Object.assign(
      jest.fn(() => ({ images: { edit, generate }, responses: { create: complete } })),
      { APIError: MockAPIError },
    ),
    toFile: jest.fn(async (_bytes: Buffer, name: string) => ({ name })),
  };
});

const { storyId, ownerId, revision, config } = premiumManifestFixture();
const scope = { storyId, ownerId, revision };
const imageBytes = Buffer.from('synthetic image response');
const output = { data: [{ b64_json: imageBytes.toString('base64') }] };

beforeEach(() => {
  jest.clearAllMocks();
  edit.mockResolvedValue(output);
  generate.mockResolvedValue(output);
  complete.mockResolvedValue({ output_text: '{"answer":"ok"}', output: [] });
});

describe('premium image adapter', () => {
  it('submits a single low-quality transparent motif request using the selected Sunburst model', async () => {
    const reportUsage = jest.fn(async () => {});
    const openingMotif = await generatePremiumImage(
      scope,
      { ...config, quality: 'low' },
      'opening_motif',
      'Draw a paper boat.',
      '1024x1024',
      [Buffer.from('small JPEG illustration reference')],
      reportUsage,
    );
    expect(openingMotif).toEqual(imageBytes);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, timeout: 90_000 }),
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith({
      model: config.model,
      quality: 'low',
      size: '1024x1024',
      prompt: 'Draw a paper boat.',
      n: 1,
      output_format: 'png',
      background: 'transparent',
      image: [{ name: 'reference-0.jpg' }],
    });
    expect(reportUsage).toHaveBeenCalledTimes(1);
  });

  it('still requests opaque full-color story artwork', async () => {
    await generatePremiumImage(
      scope,
      config,
      'front',
      'A scene.',
      config.squareSize,
      [],
      async () => {},
    );
    expect(edit).not.toHaveBeenCalled();
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, timeout: 240_000 }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: config.model,
        size: config.squareSize,
        quality: config.quality,
        background: 'opaque',
      }),
    );
  });

  it('bounds a spread image request without SDK retries', async () => {
    await generatePremiumImage(
      scope,
      config,
      'spread-1',
      'A scene.',
      config.spreadSize,
      [],
      async () => {},
    );
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, timeout: 210_000 }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['spread-1-lettering-guide', 'spread-1-lettering-right', 'opener-lettering-left'])(
    'bounds the native lettering request %s within the workflow stage budget',
    async (phase) => {
      await generatePremiumImage(scope, config, phase, 'A scene.', '2672x2672', [], async () => {});
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0, timeout: 195_000 }),
      );
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['shot-plan-spread-1', [], 45_000],
    ['spread-1', [Buffer.from('image')], 75_000],
    ['spread-1-lettering-guide-review', [Buffer.from('image')], 30_000],
    ['opener-lettering-review', [Buffer.from('image')], 75_000],
    ['storyboard', [], 240_000],
  ] as const)(
    'bounds OpenAI %s text requests and disables SDK retries',
    async (phase, images, timeout) => {
      await generatePremiumText(
        scope,
        { provider: 'openai', model: 'test' },
        phase,
        'Prompt',
        z.object({ answer: z.string() }),
        [...images],
      );
      expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, timeout }));
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it('retries up to twice with safe picture-book framing after provider moderation blocks', async () => {
    const blocked = new OpenAI.APIError(
      400,
      { code: 'moderation_blocked' },
      'Blocked by moderation',
      new Headers(),
    );
    edit
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockResolvedValueOnce({
        data: [{ b64_json: Buffer.from('safe-image').toString('base64') }],
      });

    const image = await generatePremiumImage(
      scope,
      { provider: 'openai', model: 'gpt-image-1.5', quality: 'medium' },
      'spread-8-lettering-right',
      'Draw the scene',
      '1024x1536',
      [Buffer.from('reference')],
      jest.fn(async () => undefined),
    );

    expect(image).toEqual(Buffer.from('safe-image'));
    expect(edit).toHaveBeenCalledTimes(3);
    expect(edit).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: 'Draw the scene' }));
    expect(edit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('wholesome, non-threatening'),
      }),
    );
    expect(edit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        prompt: expect.stringContaining('wholesome original children’s book illustration'),
      }),
    );
  });

  it('returns 422 premium_image_blocked when all safe-framed retries are blocked', async () => {
    const blocked = new OpenAI.APIError(
      400,
      { code: 'moderation_blocked' },
      'Blocked by moderation',
      new Headers(),
    );
    generate
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked);

    await expect(
      generatePremiumImage(
        scope,
        { provider: 'openai', model: 'gpt-image-1.5', quality: 'medium' },
        'spread-8-lettering-right',
        'Draw the scene',
        '1024x1536',
        [],
        jest.fn(async () => undefined),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'premium_image_blocked' });

    expect(generate).toHaveBeenCalledTimes(3);
  });
});
