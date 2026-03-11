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

  it('posts the print QA alert through the template endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => 'ok',
    });

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
        coverCmykPdfUrl:
          'https://storage.googleapis.com/test-bucket/story-1/print/cover_cmyk.pdf',
      },
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notify.example.com/email/template',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer notify-key',
          'X-API-Key': 'notify-key',
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
