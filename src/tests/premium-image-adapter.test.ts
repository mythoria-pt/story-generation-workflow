import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import OpenAI from 'openai';
import { generatePremiumImage } from '@/services/premium-book-ai.js';
import { premiumManifestFixture } from './fixtures/premium-book.js';

const edit = jest.fn();
const generate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(() => ({ images: { edit, generate } })),
  toFile: jest.fn(async (_bytes: Buffer, name: string) => ({ name })),
}));

const { storyId, ownerId, revision, config } = premiumManifestFixture();
const scope = { storyId, ownerId, revision };
const imageBytes = Buffer.from('synthetic image response');
const output = { data: [{ b64_json: imageBytes.toString('base64') }] };

beforeEach(() => {
  jest.clearAllMocks();
  edit.mockResolvedValue(output);
  generate.mockResolvedValue(output);
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
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: config.model,
        size: config.squareSize,
        quality: config.quality,
        background: 'opaque',
      }),
    );
  });
});
