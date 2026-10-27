import express from 'express';
import request from 'supertest';
import apiKeyAuth from '@/middleware/apiKeyAuth.js';
import { storyGuideRouter } from '@/routes/story-guide.js';
import { StoryGuideQuotaError } from '@/services/story-guide-quota.js';
import { StoryGuideTimeoutError } from '@/services/story-guide.js';
const mockGenerate = jest.fn();
jest.mock('@/services/story-guide.js', () => ({
  generateStoryGuideQuestion: (...args: unknown[]) => mockGenerate(...args),
  StoryGuideTimeoutError: class extends Error {},
}));
jest.mock('@/services/story-guide-quota.js', () => ({
  StoryGuideQuotaError: class extends Error {},
}));
const app = express();
app.use(express.json());
app.use('/ai', apiKeyAuth, storyGuideRouter);
const body = {
  authorId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c21',
  guideSessionId: 'e9428e21-4f9c-4d3e-8c3b-e49f9a528c22',
  revision: 0,
  locale: 'en-US',
  template: { id: 'moon', version: 1, premise: 'Moon', mode: 'fiction' },
  answers: [],
};
describe('story guide route', () => {
  const original = process.env.STORY_TEMPLATES_ENABLED;
  beforeEach(() => {
    process.env.STORY_TEMPLATES_ENABLED = 'true';
    jest.clearAllMocks();
    mockGenerate.mockResolvedValue({ revision: 0, source: 'ai', question: null });
  });
  afterAll(() => {
    if (original === undefined) delete process.env.STORY_TEMPLATES_ENABLED;
    else process.env.STORY_TEMPLATES_ENABLED = original;
  });
  const post = () =>
    request(app)
      .post('/ai/text/story-guide')
      .set('x-api-key', process.env.STORY_GENERATION_WORKFLOW_API_KEY!);
  it('requires the service key', async () => {
    expect((await request(app).post('/ai/text/story-guide').send(body)).status).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
  it('defaults off and rejects invalid input', async () => {
    delete process.env.STORY_TEMPLATES_ENABLED;
    expect((await post().send(body)).status).toBe(404);
    process.env.STORY_TEMPLATES_ENABLED = 'true';
    expect((await post().send({ ...body, authorId: 'forged' })).status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
  it('returns a valid response', async () => {
    expect((await post().send(body)).body).toEqual({ revision: 0, source: 'ai', question: null });
  });
  it.each([
    [new StoryGuideQuotaError('quota'), 429],
    [new StoryGuideTimeoutError('timeout'), 504],
    [new Error('PRIVATE'), 502],
  ])('returns safe errors', async (error, status) => {
    mockGenerate.mockRejectedValue(error);
    const response = await post().send(body);
    expect(response.status).toBe(status);
    expect(response.text).not.toContain('PRIVATE');
  });
});
