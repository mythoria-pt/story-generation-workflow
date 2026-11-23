import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('sendPrintQaCriticalEmail', () => {
  const originalEnv = { ...process.env };
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      PORT: '8080',
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'mythoria',
      GOOGLE_CLOUD_PROJECT_ID: 'test-project',
      GOOGLE_CLOUD_REGION: 'europe-west9',
      STORAGE_BUCKET_NAME: 'test-bucket',
      NOTIFICATION_ENGINE_URL: 'https://notify.example.com',
      NOTIFICATION_ENGINE_API_KEY: 'notify-key',
    };
    global.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const first = { recipient: 'admin1@example.com', success: true };
  const second = { recipient: 'admin2@example.com', success: true };
  const legacy = (results: (typeof first)[], successful: number, idempotent = false) => ({
    success: successful > 0,
    data: { results, summary: { total: 2, successful, failed: 2 - successful }, idempotent },
  });

  it.each([
    [200, { success: true, data: { deliveryStatus: 'sent' } }, 'sent'],
    [202, { success: true, data: { deliveryStatus: 'pending' } }, 'accepted'],
    [202, { success: true, data: { deliveryStatus: 'unknown' } }, 'unknown'],
    [200, legacy([first, second], 2), 'sent'],
    [200, legacy([first, second], 2, true), 'sent'],
    [200, legacy([first, { ...second, success: false }], 1), 'partial'],
    [
      500,
      legacy(
        [first, second].map((r) => ({ ...r, success: false })),
        0,
      ),
      'failed',
    ],
    [200, legacy([first, first], 2), 'unknown'],
    [200, { success: true, data: { messageId: 'ambiguous-for-batch' } }, 'unknown'],
    [502, null, 'unknown'],
    [undefined, undefined, 'unknown'],
  ])('posts a run-scoped alert and handles HTTP %s (%j)', async (status, response, expected) => {
    if (status === undefined) fetchMock.mockRejectedValue(new Error('connection lost'));
    else fetchMock.mockResolvedValue({ status, json: async () => response });

    const { sendPrintQaCriticalEmail } = await import('@/services/notification-client.js');
    const sent = await sendPrintQaCriticalEmail({
      storyId: 'story-1',
      storyTitle: 'The Hidden Valley',
      runId: 'run-1',
      reportUrl: 'https://storage.googleapis.com/test-bucket/story-1/print/qa/report.json',
      recipientCount: 2,
      recipients: [
        { email: 'admin1@example.com', name: 'Admin One', language: 'en-US' },
        { email: 'admin2@example.com', name: 'Admin Two', language: 'en-US' },
      ],
      criticalErrors: [
        {
          code: 'chapter_sparse_last_page',
          message: 'Chapter 4 ends on an almost empty page.',
          chapterNumber: 4,
          pageNumbers: [51],
          suggestedFix: 'Reflow the last two pages of chapter 4.',
        },
      ],
      fixesApplied: [{ chapterNumber: 4, strategy: 'tighten-chapter-spacing-soft' }],
      printResult: {
        interiorPdfUrl: 'https://storage.googleapis.com/test-bucket/story-1/print/interior.pdf',
        coverPdfUrl: 'https://storage.googleapis.com/test-bucket/story-1/print/cover.pdf',
        interiorCmykPdfUrl:
          'https://storage.googleapis.com/test-bucket/story-1/print/interior_cmyk.pdf',
        coverCmykPdfUrl: 'https://storage.googleapis.com/test-bucket/story-1/print/cover_cmyk.pdf',
      },
    });

    expect(sent).toBe(expected);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notify.example.com/email/template',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer notify-key',
          'X-API-Key': 'notify-key',
          'Idempotency-Key': 'print-qa-critical:run-1',
        }),
        body: expect.any(String),
      }),
    );

    const [, request] = fetchMock.mock.calls[0] as [string, { body: string }];
    const payload = JSON.parse(request.body);
    expect(payload.templateId).toBe('print-qa-critical');
    expect(payload.recipients).toHaveLength(2);
    expect(payload.variables.criticalErrors).toHaveLength(1);
  });
});

describe('sendStoryPrintInstructionsEmail delivery status', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      NOTIFICATION_ENGINE_URL: 'https://notify.example.com',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it.each([
    [{ success: true, result: { success: true, data: { deliveryStatus: 'sent' } } }, 'sent'],
    [{ success: true, data: { deliveryStatus: 'pending' } }, 'accepted'],
    [{ success: true, data: { deliveryStatus: 'unknown' } }, 'unknown'],
    [{ success: true, data: { status: 'sent', provider: 'Gmail', messageId: 'abc' } }, 'sent'],
    [{ success: true, data: { status: 'sent', provider: 'Gmail', messageId: '' } }, 'unknown'],
    [{ success: true, data: { status: 'sent', provider: 'mock', messageId: 'abc' } }, 'unknown'],
    [
      {
        success: true,
        data: { deliveryStatus: 'unknown', status: 'sent', provider: 'Gmail', messageId: 'abc' },
      },
      'unknown',
    ],
    [{ success: true, result: { success: false } }, 'failed'],
    [{ success: true }, 'unknown'],
  ])('maps a successful HTTP response with body %j to %s', async (response, expected) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => response,
    }) as unknown as typeof global.fetch;
    const { sendStoryPrintInstructionsEmail } = await import('@/services/notification-client.js');

    await expect(
      sendStoryPrintInstructionsEmail({
        storyId: 'story-1',
        storyTitle: 'The Hidden Valley',
        workflowId: 'run-1',
        recipient: { email: 'reader@example.com' },
        pdfs: {
          coverPdfUrl: 'gs://test-bucket/cover.pdf',
          interiorPdfUrl: 'gs://test-bucket/interior.pdf',
          interiorCmykPdfUrl: 'gs://test-bucket/interior_cmyk.pdf',
          coverCmykPdfUrl: 'gs://test-bucket/cover_cmyk.pdf',
        },
      }),
    ).resolves.toBe(expected);
  });
});
