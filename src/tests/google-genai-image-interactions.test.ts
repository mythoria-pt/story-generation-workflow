import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockInteractionsCreate = jest.fn<any>();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    interactions: { create: mockInteractionsCreate },
  })),
}));

jest.mock('@/config/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { logger } from '@/config/logger.js';
import { GoogleGenAIImageService } from '../ai/providers/google-genai/image.js';

function buildImageInteraction(data: string) {
  return {
    id: 'interaction-1',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'image', data, mime_type: 'image/jpeg' }],
      },
    ],
    output_image: { type: 'image', data, mime_type: 'image/jpeg' },
  };
}

describe('GoogleGenAIImageService Interactions API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_GENAI_FORCE_REST;
    delete process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING;
    delete process.env.GOOGLE_GENAI_USE_VERTEX;
    mockInteractionsCreate.mockResolvedValue(
      buildImageInteraction(Buffer.from('generated').toString('base64')),
    );
  });

  it('generates with the stable image model and current response format', async () => {
    const service = new GoogleGenAIImageService({
      apiKey: 'key',
      model: 'gemini-3.1-flash-image',
    });

    const buffer = await service.generate('Create a cover', {
      aspectRatio: '16:9',
      systemPrompt: 'Keep the visual style consistent.',
      referenceImages: [
        {
          buffer: Buffer.from('reference'),
          mimeType: 'image/jpeg',
          source: 'character-reference',
          label: 'Character reference: Maya',
        },
      ],
    });

    expect(buffer.toString()).toBe('generated');
    expect(mockInteractionsCreate).toHaveBeenCalledTimes(1);
    expect(mockInteractionsCreate).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-image',
      input: [
        { type: 'text', text: 'Character reference: Maya' },
        {
          type: 'image',
          data: Buffer.from('reference').toString('base64'),
          mime_type: 'image/jpeg',
        },
        { type: 'text', text: expect.stringContaining('keep every character and style identity') },
        { type: 'text', text: 'Create a cover' },
      ],
      system_instruction: 'Keep the visual style consistent.',
      response_format: {
        type: 'image',
        mime_type: 'image/jpeg',
        aspect_ratio: '16:9',
        image_size: '2K',
      },
    });
  });

  it('edits an image through a multimodal interaction', async () => {
    const service = new GoogleGenAIImageService({
      apiKey: 'key',
      model: 'gemini-3.1-flash-image',
    });

    const buffer = await service.edit('Change the background', Buffer.from('original'), {
      aspectRatio: '2:3',
      imageType: 'front_cover',
    });

    expect(buffer.toString()).toBe('generated');
    expect(mockInteractionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-image',
        input: [
          { type: 'text', text: expect.stringContaining('Image to edit') },
          {
            type: 'image',
            data: Buffer.from('original').toString('base64'),
            mime_type: 'image/jpeg',
          },
          { type: 'text', text: 'Change the background' },
        ],
        response_format: {
          type: 'image',
          mime_type: 'image/jpeg',
          aspect_ratio: '2:3',
          image_size: '2K',
        },
      }),
    );
  });

  it.each(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image'])(
    'sends image_size 2K for %s',
    async (model) => {
      const service = new GoogleGenAIImageService({ apiKey: 'key', model });

      await service.generate('Create a cover', { aspectRatio: '2:3' });

      expect(mockInteractionsCreate.mock.calls[0][0].response_format).toEqual({
        type: 'image',
        mime_type: 'image/jpeg',
        aspect_ratio: '2:3',
        image_size: '2K',
      });
    },
  );

  it('omits image_size for models without size support', async () => {
    const service = new GoogleGenAIImageService({ apiKey: 'key', model: 'gemini-2.5-flash-image' });

    await service.generate('Create a cover', { aspectRatio: '2:3' });

    expect(mockInteractionsCreate.mock.calls[0][0].response_format).not.toHaveProperty(
      'image_size',
    );
  });

  it('defaults to gemini-nano-banana-2.1 and remaps legacy imagen models to it', async () => {
    await new GoogleGenAIImageService({ apiKey: 'key' }).generate('Create a cover');
    await new GoogleGenAIImageService({ apiKey: 'key', model: 'imagen-4.0-generate' }).generate(
      'Create a cover',
    );

    expect(mockInteractionsCreate.mock.calls[0][0].model).toBe('gemini-nano-banana-2.1');
    expect(mockInteractionsCreate.mock.calls[1][0].model).toBe('gemini-nano-banana-2.1');
  });

  it('interleaves a label before each reference image with a numbered fallback', async () => {
    const service = new GoogleGenAIImageService({ apiKey: 'key', model: 'gemini-nano-banana-2.1' });

    await service.generate('Draw chapter 2', {
      referenceImages: [
        { buffer: Buffer.from('a'), mimeType: 'image/jpeg', source: 'cover', label: 'Front cover' },
        { buffer: Buffer.from('b'), mimeType: 'image/jpeg', source: 'chapter_1' },
      ],
    });

    const input = mockInteractionsCreate.mock.calls[0][0].input;
    expect(input.map((p: { type: string }) => p.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
      'text',
      'text',
    ]);
    expect(input[0].text).toBe('Front cover');
    expect(input[2].text).toBe('Reference image 2');
    expect(input[4].text).toContain('keep every character and style identity');
    expect(input[5].text).toBe('Draw chapter 2');
  });

  it('caps reference images at 14 and warns when trimming', async () => {
    const service = new GoogleGenAIImageService({ apiKey: 'key', model: 'gemini-nano-banana-2.1' });
    const referenceImages = Array.from({ length: 16 }, (_, i) => ({
      buffer: Buffer.from(`ref-${i}`),
      mimeType: 'image/jpeg',
      source: `ref-${i}`,
    }));

    await service.generate('Create a cover', { referenceImages });

    const input = mockInteractionsCreate.mock.calls[0][0].input;
    expect(input.filter((p: { type: string }) => p.type === 'image')).toHaveLength(14);
    expect(logger.warn).toHaveBeenCalledWith(
      'Reference images exceed Gemini limit; trimming',
      expect.objectContaining({ providedCount: 16, maxImages: 14 }),
    );
  });

  it('counts the edited image toward the 14 image cap on edit', async () => {
    const service = new GoogleGenAIImageService({ apiKey: 'key', model: 'gemini-nano-banana-2.1' });
    const referenceImages = Array.from({ length: 14 }, (_, i) => ({
      buffer: Buffer.from(`ref-${i}`),
      mimeType: 'image/jpeg',
      source: `ref-${i}`,
    }));

    await service.edit('Make the sky pink', Buffer.from('original'), { referenceImages });

    const input = mockInteractionsCreate.mock.calls[0][0].input;
    expect(input.filter((p: { type: string }) => p.type === 'image')).toHaveLength(14);
    expect(input[input.length - 1]).toEqual({ type: 'text', text: 'Make the sky pink' });
  });

  it('attaches Interactions usage with the image/text token split', async () => {
    mockInteractionsCreate.mockResolvedValue({
      ...buildImageInteraction(Buffer.from('generated').toString('base64')),
      usage: {
        total_input_tokens: 900,
        total_output_tokens: 1700,
        total_thought_tokens: 300,
        output_tokens_by_modality: [
          { modality: 'image', tokens: 1680 },
          { modality: 'text', tokens: 20 },
        ],
      },
    });
    const service = new GoogleGenAIImageService({ apiKey: 'key', model: 'gemini-nano-banana-2.1' });

    const buffer = (await service.generate('Create a cover')) as Buffer & {
      __geminiUsage?: unknown;
    };

    expect(buffer.__geminiUsage).toEqual({
      inputTokens: 900,
      outputTokens: 2000,
      imageOutputTokens: 1680,
      imageSize: '2K',
    });
  });
});
