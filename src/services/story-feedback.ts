import { eq } from 'drizzle-orm';
import { normalizeLocale } from '@/config/locales.js';
import { getDatabase } from '@/db/connection.js';
import { authors } from '@/db/schema/authors.js';
import { sendStoryFeedbackEmail } from './notification-client.js';
import { StoryService } from './story.js';

export async function submitStoryFeedback(input: {
  storyId: string;
  senderAuthorId: string;
  subject: string;
  message: string;
}) {
  const story = await new StoryService().getStory(input.storyId);
  if (!story || (!story.isPublic && story.authorId !== input.senderAuthorId)) {
    return { status: 404, error: 'Story not found' };
  }
  if (!story.authorEmail) {
    return { status: 400, error: 'Story author email not available' };
  }

  const [sender] = await getDatabase()
    .select({ name: authors.displayName, email: authors.email, locale: authors.preferredLocale })
    .from(authors)
    .where(eq(authors.authorId, input.senderAuthorId))
    .limit(1);
  if (!sender?.email) {
    return { status: 404, error: 'Sender not found' };
  }

  const language = normalizeLocale(story.authorPreferredLocale || story.storyLanguage);
  const baseUrl = (process.env.APP_BASE_URL || 'https://mythoria.pt').replace(/\/$/, '');
  const authorName = story.author || 'Mythoria Author';
  const sent = await sendStoryFeedbackEmail({
    storyId: input.storyId,
    authorId: story.authorId,
    recipients: [{ email: story.authorEmail, name: authorName, language }],
    cc:
      sender.email.toLowerCase() === story.authorEmail.toLowerCase()
        ? []
        : [{ email: sender.email, name: sender.name, language: normalizeLocale(sender.locale) }],
    variables: {
      authorName,
      storyTitle: story.title,
      storyUrl: `${baseUrl}/${language}/stories/read/${story.storyId}`,
      senderName: sender.name,
      senderEmail: sender.email,
      subject: input.subject,
      message: input.message,
    },
    metadata: { notificationType: 'story-feedback', senderAuthorId: input.senderAuthorId },
  });

  if (!sent) return { status: 502, error: 'Unable to send feedback at the moment' };
  return undefined;
}
