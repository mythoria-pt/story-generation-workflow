import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

export interface StoryCreatedEmailPayload {
  storyId: string;
  templateId: 'story-created';
  recipients: Array<{ email: string; name?: string; language?: string }>;
  variables: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  metadata?: Record<string, unknown>;
}

export interface StoryPrintInstructionsEmailPayload {
  storyId: string;
  storyTitle: string;
  workflowId: string;
  recipient: { email: string; name?: string; language?: string };
  cc?: Array<{ email: string; name?: string; language?: string }>;
  pdfs: {
    interiorPdfUrl: string;
    coverPdfUrl: string;
    interiorCmykPdfUrl?: string | null;
    coverCmykPdfUrl?: string | null;
  };
  locale?: string;
  storyLanguage?: string | null;
  metadata?: Record<string, unknown>;
}

const PDF_MIME_TYPE = 'application/pdf';

function normalizeStorageUri(uri: string): string {
  if (uri.startsWith('gs://')) {
    return uri;
  }

  try {
    const parsed = new URL(uri);
    const path = parsed.pathname.replace(/^\//, '');
    if (
      parsed.hostname === 'storage.googleapis.com' &&
      path.includes('/')
    ) {
      const [bucket, ...rest] = path.split('/');
      return `gs://${bucket}/${rest.join('/')}`;
    }
    if (parsed.hostname.endsWith('.storage.googleapis.com')) {
      const bucket = parsed.hostname.replace('.storage.googleapis.com', '');
      return `gs://${bucket}/${path}`;
    }
  } catch (_error) {
    // fall through and return original URI
  }

  return uri;
}

function inferFilenameFromUri(uri: string): string | undefined {
  const sanitized = uri.split('?')[0];
  const fromGs = sanitized.replace(/^gs:\/\//, '');
  const parts = fromGs.split('/').filter(Boolean);
  return parts.pop();
}

function buildPdfReference(
  uri: string | null | undefined,
  label: string,
  fallbackFilename: string,
):
  | {
      uri: string;
      label: string;
      filename?: string;
      mimeType: string;
    }
  | undefined {
  if (!uri) {
    return undefined;
  }

  const normalized = normalizeStorageUri(uri);
  const reference = {
    uri: normalized,
    label,
    mimeType: PDF_MIME_TYPE,
  } as {
    uri: string;
    label: string;
    filename?: string;
    mimeType: string;
  };

  const derivedName = inferFilenameFromUri(normalized) ?? fallbackFilename;
  if (derivedName) {
    reference.filename = derivedName;
  }

  return reference;
}

function deriveRequestedBy(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const requestedByName = typeof metadata['requestedByName'] === 'string' ? metadata['requestedByName'] : undefined;
  const requestedByEmail = typeof metadata['requestedByEmail'] === 'string' ? metadata['requestedByEmail'] : undefined;
  const requestedByAuthorId = typeof metadata['requestedByAuthorId'] === 'string' ? metadata['requestedByAuthorId'] : undefined;

  if (requestedByName && requestedByEmail) {
    return `${requestedByName} <${requestedByEmail}>`;
  }

  return requestedByEmail ?? requestedByName ?? requestedByAuthorId;
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
    storyId: payload.storyId,
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

export async function sendStoryPrintInstructionsEmail(
  payload: StoryPrintInstructionsEmailPayload,
): Promise<boolean> {
  const env = getEnvironment();
  if (!env.NOTIFICATION_ENGINE_URL) {
    logger.warn('Notification Engine URL not configured; skipping story-print email');
    return false;
  }

  const baseUrl = env.NOTIFICATION_ENGINE_URL.replace(/\/$/, '');
  const url = `${baseUrl}/email/story-print-instructions`;
  const headers = buildHeaders(env);
  const locale =
    payload.locale ||
    payload.recipient.language ||
    payload.storyLanguage ||
    'en-US';

  const coverPdf = buildPdfReference(
    payload.pdfs.coverPdfUrl,
    'Cover spread (PDF)',
    'cover.pdf',
  );
  const interiorPdf = buildPdfReference(
    payload.pdfs.interiorPdfUrl,
    'Interior pages (PDF)',
    'interior.pdf',
  );
  const additionalPdfs = [
    buildPdfReference(payload.pdfs.coverCmykPdfUrl, 'Cover (CMYK PDF)', 'cover-cmyk.pdf'),
    buildPdfReference(
      payload.pdfs.interiorCmykPdfUrl,
      'Interior (CMYK PDF)',
      'interior-cmyk.pdf',
    ),
  ].filter(Boolean) as Array<{ uri: string; label: string; filename?: string; mimeType: string }>;

  if (!coverPdf && !interiorPdf && additionalPdfs.length === 0) {
    logger.error('No printable assets available for story-print email', {
      storyId: payload.storyId,
      workflowId: payload.workflowId,
    });
    return false;
  }

  const requestBody: Record<string, unknown> = {
    recipient: {
      email: payload.recipient.email,
      ...(payload.recipient.name ? { name: payload.recipient.name } : {}),
      ...(payload.recipient.language ? { language: payload.recipient.language } : {}),
    },
    ...(payload.cc && payload.cc.length
      ? {
          cc: payload.cc.map((ccRecipient) => ({
            email: ccRecipient.email,
            ...(ccRecipient.name ? { name: ccRecipient.name } : {}),
          })),
        }
      : {}),
    story: {
      id: payload.storyId,
      title: payload.storyTitle,
      locale,
    },
    workflowExecutionId: (payload.metadata?.workflowExecutionId as string | undefined) ?? payload.workflowId,
  };

  if (coverPdf) {
    requestBody.coverPdf = coverPdf;
  }
  if (interiorPdf) {
    requestBody.interiorPdf = interiorPdf;
  }
  if (additionalPdfs.length) {
    requestBody.additionalPdfs = additionalPdfs;
  }

  const requestedBy = deriveRequestedBy(payload.metadata);
  if (requestedBy) {
    requestBody.requestedBy = requestedBy;
  }

  const body = JSON.stringify(requestBody);

  logger.info('Attempting to send story-print instructions email', {
    url,
    storyId: payload.storyId,
    workflowId: payload.workflowId,
    recipient: payload.recipient.email,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error('Failed to send story-print email', {
        status: response.status,
        statusText: response.statusText,
        body: text,
      });
      return false;
    }

    logger.info('story-print email dispatched successfully', {
      storyId: payload.storyId,
      workflowId: payload.workflowId,
    });
    return true;
  } catch (error) {
    logger.error('Error calling notification engine for story-print email', {
      error: error instanceof Error ? error.message : String(error),
      storyId: payload.storyId,
      workflowId: payload.workflowId,
    });
    return false;
  }
}
