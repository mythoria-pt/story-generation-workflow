import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const uploadFileMock = jest.fn();
const fileExistsMock = jest.fn();
const deleteFileMock = jest.fn();

jest.mock('@/ai/gateway-with-tracking.js', () => ({
  getAIGatewayWithTokenTracking: jest.fn(() => ({
    getTextService: jest.fn(),
    getImageService: jest.fn(),
  })),
}));

jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({
    getStoryContext: jest.fn(),
  })),
}));

jest.mock('@/services/characters.js', () => ({
  CharacterService: jest.fn(() => ({})),
}));

jest.mock('@/services/runs.js', () => ({
  RunsService: jest.fn(() => ({})),
}));

jest.mock('@/services/image-safety-service.js', () => ({
  ImageSafetyService: jest.fn(() => ({})),
}));

jest.mock('@/services/storage-singleton.js', () => ({
  getStorageService: jest.fn(() => ({
    uploadFile: uploadFileMock,
    fileExists: fileExistsMock,
    deleteFile: deleteFileMock,
  })),
}));

import { aiRouter } from '../ai';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/ai', aiRouter);

describe('POST /ai/media/character-photo', () => {
  const authorId = '00000000-0000-4000-8000-000000000001';
  const characterId = '00000000-0000-4000-8000-000000000002';
  const dataUrl = `data:image/jpeg;base64,${Buffer.from('photo-bytes').toString('base64')}`;

  beforeEach(() => {
    jest.clearAllMocks();
    uploadFileMock.mockImplementation((filename: string) =>
      Promise.resolve(`https://storage.googleapis.com/test-bucket/${filename}`),
    );
  });

  it('stores each upload for the same character at a unique immutable path', async () => {
    const first = await request(app).post('/ai/media/character-photo').send({
      authorId,
      characterId,
      dataUrl,
    });
    const second = await request(app).post('/ai/media/character-photo').send({
      authorId,
      characterId,
      dataUrl,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(second.body.success).toBe(true);
    expect(first.body.gcsPath).not.toBe(second.body.gcsPath);

    for (const body of [first.body, second.body]) {
      expect(body.gcsPath).toEqual(
        expect.stringContaining(`characters/${authorId}/${characterId}/`),
      );
      expect(body.gcsPath).toEqual(expect.stringMatching(/\/\d+-[a-f0-9]{12}\.jpg$/));
      expect(body.publicUrl).toBe(`https://storage.googleapis.com/test-bucket/${body.gcsPath}`);
    }

    expect(uploadFileMock).toHaveBeenCalledTimes(2);
    expect(uploadFileMock).toHaveBeenNthCalledWith(
      1,
      first.body.gcsPath,
      expect.any(Buffer),
      'image/jpeg',
      { cacheControl: 'public, max-age=31536000' },
    );
    expect(uploadFileMock).toHaveBeenNthCalledWith(
      2,
      second.body.gcsPath,
      expect.any(Buffer),
      'image/jpeg',
      { cacheControl: 'public, max-age=31536000' },
    );
  });
});
