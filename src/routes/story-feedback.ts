import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { submitStoryFeedback } from '@/services/story-feedback.js';

export const storyFeedbackRouter = Router();

const feedbackSchema = z.object({
  storyId: z.uuid(),
  senderAuthorId: z.uuid(),
  subject: z.string().trim().min(3).max(80),
  message: z.string().trim().min(10).max(800),
});

storyFeedbackRouter.post('/', async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid story feedback' });
    return;
  }

  try {
    const result = await submitStoryFeedback(parsed.data);
    if (result) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Story feedback could not be submitted', {
      storyId: parsed.data.storyId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
