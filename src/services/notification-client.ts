import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

export interface StoryCreatedEmailPayload {
  templateId: 'story-created';
  recipients: Array<{ email: string; name?: string; language?: string }>;
  variables: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  metadata?: Record<string, unknown>;
}

function buildHeaders(env: ReturnType<typeof getEnvironment>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.NOTIFICATION_ENGINE_API_KEY) {
    headers['Authorization'] = `Bearer ${env.NOTIFICATION_ENGINE_API_KEY}`;
    headers['X-API-Key'] = env.NOTIFICATION_ENGINE_API_KEY; // backup for middleware
  }
  return headers;
}

export async function sendStoryCreatedEmail(payload: StoryCreatedEmailPayload): Promise<boolean> {
  const env = getEnvironment();
  if (!env.NOTIFICATION_ENGINE_URL) {
    logger.warn('Notification Engine URL not configured; skipping story-created email');
    return false;
  }

  const url = `${env.NOTIFICATION_ENGINE_URL.replace(/\/$/, '')}/email/template`;

  // Enhanced debugging
  logger.info('Attempting to send story-created email', {
    url,
    templateId: payload.templateId,
    recipientCount: payload.recipients.length,
    recipients: payload.recipients.map((r) => r.email),
    hasApiKey: !!env.NOTIFICATION_ENGINE_API_KEY,
    variables: payload.variables,
  });

  try {
    const headers = buildHeaders(env);
    const body = JSON.stringify(payload);

    logger.debug('Request details', {
      headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined },
      bodyLength: body.length,
      payload: payload,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('Failed to send story-created email', {
        status: res.status,
        statusText: res.statusText,
        responseHeaders: Object.fromEntries(res.headers.entries()),
        body: text,
      });
      return false;
    }

    const responseText = await res.text();
    logger.info('story-created email dispatched successfully', {
      recipients: payload.recipients.map((r) => r.email),
      response: responseText,
    });
    return true;
  } catch (err) {
    logger.error('Error calling notification engine', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      url,
    });
    return false;
  }
}
