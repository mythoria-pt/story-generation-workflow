import { Router } from 'express';
import { storyGuideRequestSchema } from '@/services/story-guide-contract.js';
import { generateStoryGuideQuestion, StoryGuideTimeoutError } from '@/services/story-guide.js';
import { StoryGuideQuotaError } from '@/services/story-guide-quota.js';
import { logger } from '@/config/logger.js';

export const storyGuideRouter = Router();
storyGuideRouter.post('/text/story-guide', async (req, res) => {
  if (process.env.STORY_TEMPLATES_ENABLED !== 'true') {
    res.status(404).json({ error: 'Story guide unavailable' });
    return;
  }
  const parsed = storyGuideRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid story guide request' });
    return;
  }
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abort);
  try {
    res.json(await generateStoryGuideQuestion(parsed.data, controller.signal));
  } catch (error) {
    const status =
      error instanceof StoryGuideQuotaError
        ? 429
        : error instanceof StoryGuideTimeoutError
          ? 504
          : 502;
    logger.warn('Story guide request unavailable', { status, revision: parsed.data.revision });
    if (!res.destroyed) res.status(status).json({ error: 'Story guide unavailable' });
  } finally {
    res.off('close', abort);
  }
});
