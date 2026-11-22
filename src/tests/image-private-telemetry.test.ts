import { setImmediate } from 'node:timers';
import { ImageGenerationMiddleware } from '@/ai/token-tracking-middleware';
const record = jest.fn().mockResolvedValue(undefined);
const logError = jest.fn();
jest.mock('@/services/token-usage-tracking', () => ({
  tokenUsageTrackingService: { recordUsage: (...args: unknown[]) => record(...args) },
}));
jest.mock('@/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: (...args: unknown[]) => logError(...args),
  },
}));
const context = { authorId: 'author', storyId: 'story', action: 'image_generation' as const };
const privateText = 'Private family holiday in secret location';
const options = {
  privateContent: true,
  bookTitle: privateText,
  customInstructions: privateText,
  systemPrompt: privateText,
  referenceImages: [
    {
      buffer: Buffer.from('image'),
      mimeType: 'image/jpeg',
      source: 'biographer_reference',
      label: privateText,
    },
  ],
};
describe('private image generation telemetry', () => {
  beforeEach(() => {
    record.mockClear();
    logError.mockClear();
  });
  it('records usage without prompt, title, instructions, captions or buffers', async () => {
    const middleware = new ImageGenerationMiddleware(
      { generate: async () => Buffer.from('generated') },
      context,
    );
    await middleware.generate(privateText, options);
    await new Promise((resolve) => setImmediate(resolve));
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(record.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(record.mock.calls)).not.toContain('generated');
  });
  it('never logs an error that includes private prompt content', async () => {
    const middleware = new ImageGenerationMiddleware(
      {
        generate: async () => {
          throw new Error(privateText);
        },
      },
      context,
    );
    await expect(middleware.generate(privateText, options)).rejects.toThrow();
    expect(JSON.stringify(logError.mock.calls)).not.toContain(privateText);
  });
});
