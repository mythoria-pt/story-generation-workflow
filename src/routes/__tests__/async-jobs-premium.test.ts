import express from 'express';
import request from 'supertest';
import { asyncJobRouter } from '../async-jobs.js';

const mockGetStory = jest.fn();
const mockCreateJob = jest.fn();

jest.mock('@/services/story.js', () => ({
  StoryService: jest.fn(() => ({ getStory: (id: string) => mockGetStory(id) })),
}));
jest.mock('@/services/job-manager.js', () => ({
  jobManager: { createJob: (...args: unknown[]) => mockCreateJob(...args) },
  getEstimatedDuration: jest.fn(),
}));

const app = express();
app.use(express.json(), asyncJobRouter);
describe('premium stories on chapter job endpoints', () => {
  it.each([
    ['/translate-text', { targetLocale: 'pt-PT' }],
    ['/text-edit', { userRequest: 'Shorten this passage' }],
    [
      '/image-edit',
      { imageType: 'cover', imageUrl: 'gs://sample/cover.jpg', userRequest: 'Add a boat' },
    ],
  ] as const)('rejects %s before creating a chargeable job', async (path, payload) => {
    mockGetStory.mockResolvedValue({
      features: { premiumBook: { version: 1, type: 'premium_children' } },
    });
    await request(app)
      .post(path)
      .send({ storyId: 'premium-story', ...payload })
      .expect(409);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});
