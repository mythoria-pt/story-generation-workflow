import express from 'express';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { StoryService } from '@/services/story.js';
import { getDatabase } from '@/db/connection.js';
import { authors } from '@/db/schema/authors.js';
import { eq } from 'drizzle-orm';
import { normalizeLocale } from '@/config/locales.js';
import { sendStoryFeedbackEmail } from '@/services/notification-client.js';

export const storyFeedbackRouter = express.Router();

const storyService = new StoryService();
const db = getDatabase();

const StoryFeedbackSchema = z.object({
  storyId: z.string().uuid(),
  subject: z.string().min(3).max(80),
  message: z.string().min(10).max(800),
  senderAuthorId: z.string().uuid(),
});

storyFeedbackRouter.post('/', async (req, res) => {
  const parsed = StoryFeedbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid request payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { storyId, subject, message, senderAuthorId } = parsed.data;

  try {
    const story = await storyService.getStory(storyId);
    if (!story) {
      res.status(404).json({ success: false, error: 'Story not found' });
      return;
    }

    if (!story.authorEmail) {
      res.status(400).json({ success: false, error: 'Story author email not available' });
      return;
    }

    const [sender] = await db
      .select({
        authorId: authors.authorId,
        displayName: authors.displayName,
        email: authors.email,
        preferredLocale: authors.preferredLocale,
      })
      .from(authors)
      .where(eq(authors.authorId, senderAuthorId))
      .limit(1);

    if (!sender || !sender.email) {
      res.status(404).json({ success: false, error: 'Sender not found' });
      return;
    }

    const authorLocale = normalizeLocale(
      story.authorPreferredLocale || story.storyLanguage || 'en-US',
    );
    const senderLocale = normalizeLocale(sender.preferredLocale || 'en-US');
    const baseUrl = (process.env.APP_BASE_URL || 'https://mythoria.pt').replace(/\/$/, '');
    const storyUrl = `${baseUrl}/${authorLocale}/stories/read/${story.storyId}`;

    const emailSent = await sendStoryFeedbackEmail({
      storyId: story.storyId,
      storyTitle: story.title,
      storyAuthorId: story.authorId,
      storyAuthorName: story.author || 'Mythoria Author',
      storyAuthorEmail: story.authorEmail,
      storyAuthorLocale: authorLocale,
      senderAuthorId: sender.authorId,
      senderName: sender.displayName,
      senderEmail: sender.email,
      senderLocale,
      subject,
      message,
      storyUrl,
    });

    if (!emailSent) {
      res.status(502).json({
        success: false,
        error: 'Unable to send feedback at the moment',
      });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Story feedback endpoint error', {
      error: error instanceof Error ? error.message : String(error),
      storyId,
      senderAuthorId,
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});