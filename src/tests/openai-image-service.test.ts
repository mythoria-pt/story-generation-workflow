import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResponsesCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    responses: {
      create: mockResponsesCreate,
    },
  })),
}));

import { OpenAIImageService } from '@/ai/providers/openai/image.js';

const successfulImageResponse = () => ({
  id: 'resp_test',
  output: [
    {
      type: 'image_generation_call',
      status: 'completed',
      result: {
        b64_json: Buffer.from('image-bytes').toString('base64'),
      },
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  },
});

describe('OpenAIImageService', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockResponsesCreate.mockResolvedValue(successfulImageResponse());
  });

  it('omits input_fidelity for gpt-image-2 image generation tool requests', async () => {
    const service = new OpenAIImageService({
      apiKey: 'test-key',
      model: 'gpt-5.5',
      imageModel: 'gpt-image-2',
    });

    await service.generate('Generate a chapter illustration.', {
      systemPrompt: 'Generate story art.',
      width: 1024,
      height: 1536,
    });

    const request = mockResponsesCreate.mock.calls[0]?.[0] as any;
    expect(request.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
    });
    expect(request.tools[0]).not.toHaveProperty('input_fidelity');
  });

  it('does not send top_p for image generation responses requests', async () => {
    const service = new OpenAIImageService({
      apiKey: 'test-key',
      model: 'gpt-5.5',
      imageModel: 'gpt-image-2',
    });

    await service.generate('Generate a chapter illustration.', {
      systemPrompt: 'Generate story art.',
      width: 1024,
      height: 1536,
    });

    const request = mockResponsesCreate.mock.calls[0]?.[0] as any;
    expect(request).not.toHaveProperty('top_p');
  });

  it('does not send top_p for image edit responses requests', async () => {
    const service = new OpenAIImageService({
      apiKey: 'test-key',
      model: 'gpt-5.5',
      imageModel: 'gpt-image-2',
    });

    await service.edit('Make the moon brighter.', Buffer.from('original-image'), {
      width: 1024,
      height: 1536,
    });

    const request = mockResponsesCreate.mock.calls[0]?.[0] as any;
    expect(request).not.toHaveProperty('top_p');
    expect(request.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
    });
  });

  it('keeps input_fidelity for gpt-image-1.5 image generation tool requests', async () => {
    const service = new OpenAIImageService({
      apiKey: 'test-key',
      model: 'gpt-5.5',
      imageModel: 'gpt-image-1.5',
    });

    await service.generate('Generate a chapter illustration.', {
      systemPrompt: 'Generate story art.',
      width: 1024,
      height: 1536,
    });

    const request = mockResponsesCreate.mock.calls[0]?.[0] as any;
    expect(request.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-1.5',
      input_fidelity: 'high',
    });
  });
});
