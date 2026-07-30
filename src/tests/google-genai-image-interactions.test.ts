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

import { GoogleGenAIImageService } from '../ai/providers/google-genai/image.js';

function buildImageInteraction(data: string) {
  return {
    id: 'interaction-1',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'image', data, mime_type: 'image/png' }],
      },
    ],
    output_image: { type: 'image', data, mime_type: 'image/png' },
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
        },
      ],
    });

    expect(buffer.toString()).toBe('generated');
    expect(mockInteractionsCreate).toHaveBeenCalledTimes(1);
    expect(mockInteractionsCreate).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-image',
      input: [
        {
          type: 'image',
          data: Buffer.from('reference').toString('base64'),
          mime_type: 'image/jpeg',
        },
        {
          type: 'text',
          text: 'The preceding images are reference material. Use them to maintain consistency in characters and style.',
        },
        { type: 'text', text: 'Create a cover' },
      ],
      system_instruction: 'Keep the visual style consistent.',
      response_format: {
        type: 'image',
        mime_type: 'image/png',
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
          {
            type: 'image',
            data: Buffer.from('original').toString('base64'),
            mime_type: 'image/jpeg',
          },
          { type: 'text', text: 'Change the background' },
        ],
        response_format: {
          type: 'image',
          mime_type: 'image/png',
          aspect_ratio: '2:3',
          image_size: '2K',
        },
      }),
    );
  });
});
