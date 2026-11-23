import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

export interface StoryCreatedEmailPayload {
  storyId: string;
  entityId: string;
  runId: string;
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
  origin?: 'self-service' | 'admin' | string;
}

export interface PrintQaCriticalEmailPayload {
  storyId: string;
  storyTitle: string;
  runId: string;
  reportUrl: string | null;
  recipientCount: number;
  recipients: Array<{ email: string; name?: string; language?: string }>;
  criticalErrors: Array<{
    code: string;
    message: string;
    chapterNumber?: number;
    pageNumbers?: number[];
    suggestedFix?: string;
  }>;
  fixesApplied?: Array<{
    chapterNumber: number;
    strategy: string;
  }>;
  printResult: {
    interiorPdfUrl: string;
    coverPdfUrl: string;
    interiorCmykPdfUrl?: string | null;
    coverCmykPdfUrl?: string | null;
  };
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
    if (parsed.hostname === 'storage.googleapis.com' && path.includes('/')) {
      const [bucket, ...rest] = path.split('/');
      return `gs://${bucket}/${rest.join('/')}`;
    }
    if (parsed.hostname.endsWith('.storage.googleapis.com')) {
      const bucket = parsed.hostname.replace('.storage.googleapis.com', '');
      return `gs://${bucket}/${path}`;
    }
  } catch {
    // fall through and return original URI
  }

  return uri;
}

function inferFilenameFromUri(uri: string): string | undefined {
  const sanitized = uri.split('?')[0];
  if (!sanitized) return undefined;
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

  const requestedByName =
    typeof metadata['requestedByName'] === 'string' ? metadata['requestedByName'] : undefined;
  const requestedByEmail =
    typeof metadata['requestedByEmail'] === 'string' ? metadata['requestedByEmail'] : undefined;
  const requestedByAuthorId =
    typeof metadata['requestedByAuthorId'] === 'string'
      ? metadata['requestedByAuthorId']
      : undefined;

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

type TemplateEmailPayload = {
  templateId: string;
  recipients: Array<{ email: string; name?: string; language?: string }>;
  variables: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  metadata?: Record<string, unknown>;
  storyId?: string;
  entityId?: string;
  runId?: string;
};

function postTemplateEmail(
  url: string,
  env: ReturnType<typeof getEnvironment>,
  payload: TemplateEmailPayload,
  signal?: AbortSignal,
) {
  const headers = buildHeaders(env);
  if (payload.entityId) headers['Idempotency-Key'] = `${payload.templateId}:${payload.entityId}`;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    ...(signal && { signal }),
  });
}

async function sendTemplateEmail(payload: TemplateEmailPayload): Promise<boolean> {
  const env = getEnvironment();
  if (!env.NOTIFICATION_ENGINE_URL) {
    logger.warn('Notification Engine URL not configured; skipping templated email', {
      templateId: payload.templateId,
    });
    return false;
  }

  const url = `${env.NOTIFICATION_ENGINE_URL.replace(/\/$/, '')}/email/template`;

  try {
    const response = await postTemplateEmail(url, env, payload);

    if (!response.ok) {
      const text = await response.text();
      logger.error('Failed to send templated email', {
        templateId: payload.templateId,
        status: response.status,
        statusText: response.statusText,
        body: text,
      });
      return false;
    }

    await response.text();
    return true;
  } catch (err) {
    logger.error('Error calling notification engine for templated email', {
      error: err instanceof Error ? err.message : String(err),
      templateId: payload.templateId,
      url,
    });
    return false;
  }
}

export async function sendStoryCreatedEmail(payload: StoryCreatedEmailPayload): Promise<boolean> {
  return sendTemplateEmail(payload);
}

export type StoryPrintDeliveryStatus = 'sent' | 'accepted' | 'failed' | 'not_requested' | 'unknown';

export async function sendStoryPrintInstructionsEmail(
  payload: StoryPrintInstructionsEmailPayload,
): Promise<StoryPrintDeliveryStatus> {
  const env = getEnvironment();
  if (!env.NOTIFICATION_ENGINE_URL) {
    logger.warn('Notification Engine URL not configured; skipping story-print email');
    return 'failed';
  }

  const baseUrl = env.NOTIFICATION_ENGINE_URL.replace(/\/$/, '');
  const url = `${baseUrl}/email/story-print-instructions`;
  const headers = buildHeaders(env);
  headers['Idempotency-Key'] = `story-print-instructions:${payload.workflowId}`;
  const locale = payload.locale || payload.recipient.language || payload.storyLanguage || 'en-US';

  const additionalPdfs = [
    buildPdfReference(payload.pdfs.coverCmykPdfUrl, 'Cover (CMYK PDF)', 'cover-cmyk.pdf'),
    buildPdfReference(payload.pdfs.interiorCmykPdfUrl, 'Interior (CMYK PDF)', 'interior-cmyk.pdf'),
  ].filter(Boolean) as Array<{ uri: string; label: string; filename?: string; mimeType: string }>;

  if (additionalPdfs.length === 0) {
    logger.error('No printable assets available for story-print email', {
      storyId: payload.storyId,
      workflowId: payload.workflowId,
    });
    return 'failed';
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
    workflowExecutionId:
      (payload.metadata?.workflowExecutionId as string | undefined) ?? payload.workflowId,
  };

  const origin = payload.origin ?? (payload.metadata?.origin as string | undefined);
  if (origin) {
    requestBody.origin = origin;
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
      return 'failed';
    }

    type Outcome = {
      success?: boolean;
      deliveryStatus?: string;
      data?: { deliveryStatus?: string; reason?: string };
    };
    const result = (await response.json()) as Outcome & { result?: Outcome };
    const outcome = result.result ?? result;
    if (result.success === false || outcome.success === false) return 'failed';
    if (outcome.data?.reason === 'suppressed_for_admin_origin') return 'not_requested';

    const status = outcome.data?.deliveryStatus ?? outcome.deliveryStatus;
    if (status === 'sent') return 'sent';
    if (status === 'pending' || status === 'sending') return 'accepted';
    return status === 'failed' ? 'failed' : 'unknown';
  } catch (error) {
    logger.error('Error calling notification engine for story-print email', {
      error: error instanceof Error ? error.message : String(error),
      storyId: payload.storyId,
      workflowId: payload.workflowId,
    });
    return 'unknown';
  }
}

export type PrintQaAlertStatus = 'sent' | 'accepted' | 'partial' | 'failed' | 'unknown';

const printQaAlertResponse = z.object({
  success: z.boolean(),
  data: z
    .object({
      deliveryStatus: z.string().optional(),
      summary: z
        .object({
          total: z.number().int().nonnegative(),
          successful: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
        })
        .optional(),
      results: z.array(z.object({ recipient: z.string(), success: z.boolean() })).optional(),
    })
    .optional(),
});

function classifyPrintQaAlert(
  status: number,
  body: unknown,
  recipients: PrintQaCriticalEmailPayload['recipients'],
): PrintQaAlertStatus {
  const parsed = printQaAlertResponse.safeParse(body);
  if (!parsed.success) return 'unknown';

  const { success, data } = parsed.data;
  const deliveryStatus = data?.deliveryStatus;
  if (deliveryStatus !== undefined) {
    if (success && status === 200 && deliveryStatus === 'sent') return 'sent';
    if (success && status < 300 && ['pending', 'sending'].includes(deliveryStatus))
      return 'accepted';
    return deliveryStatus === 'failed' ? 'failed' : 'unknown';
  }

  // The legacy engine responds 200 when any recipient succeeds. Validate the
  // per-recipient results before treating all managers as notified.
  const summary = data?.summary;
  const results = data?.results;
  if (
    !summary ||
    !results ||
    summary.total !== recipients.length ||
    summary.successful + summary.failed !== summary.total ||
    results.filter((result) => result.success).length !== summary.successful
  )
    return 'unknown';

  if (!success && summary.successful === 0) return 'failed';
  if (!success || status !== 200) return 'unknown';
  if (summary.failed) return 'partial';

  const expected = recipients.map(({ email }) => email.toLowerCase()).sort();
  const delivered = results.map(({ recipient }) => recipient.toLowerCase()).sort();
  return expected.length === delivered.length &&
    expected.every((email, i) => email === delivered[i])
    ? 'sent'
    : 'unknown';
}

export async function sendPrintQaCriticalEmail(
  payload: PrintQaCriticalEmailPayload,
): Promise<PrintQaAlertStatus> {
  if (payload.recipients.length === 0) {
    logger.warn('No recipients available for print QA critical email', {
      storyId: payload.storyId,
      runId: payload.runId,
    });
    return 'failed';
  }

  const email: TemplateEmailPayload = {
    templateId: 'print-qa-critical',
    recipients: payload.recipients,
    storyId: payload.storyId,
    entityId: payload.runId,
    priority: 'high',
    metadata: {
      ...(payload.metadata || {}),
      runId: payload.runId,
      reportUrl: payload.reportUrl,
      recipientCount: payload.recipientCount,
    },
    variables: {
      storyId: payload.storyId,
      storyTitle: payload.storyTitle,
      runId: payload.runId,
      reportUrl: payload.reportUrl,
      recipientCount: payload.recipientCount,
      interiorPdfUrl: payload.printResult.interiorPdfUrl,
      coverPdfUrl: payload.printResult.coverPdfUrl,
      interiorCmykPdfUrl: payload.printResult.interiorCmykPdfUrl ?? null,
      coverCmykPdfUrl: payload.printResult.coverCmykPdfUrl ?? null,
      criticalErrors: payload.criticalErrors,
      fixesApplied: payload.fixesApplied ?? [],
    },
  };

  const env = getEnvironment();
  if (!env.NOTIFICATION_ENGINE_URL) return 'failed';
  const url = `${env.NOTIFICATION_ENGINE_URL.replace(/\/$/, '')}/email/template`;
  try {
    const response = await postTemplateEmail(url, env, email, AbortSignal.timeout(30_000));
    return classifyPrintQaAlert(response.status, await response.json(), payload.recipients);
  } catch {
    // Losing the response gives no evidence that the legacy provider did not send.
    return 'unknown';
  }
}
