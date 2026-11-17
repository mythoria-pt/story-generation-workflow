import { FallbackImageGenerationService } from '@/ai/fallback-image-service.js';
describe('private image provider boundary', () => {
  it('keeps private references with the configured provider on failure', async () => {
    const fallback = jest.fn().mockResolvedValue(Buffer.from('image'));
    const service = new FallbackImageGenerationService({
      primary: {
        generate: async () => {
          throw new Error('private provider failure');
        },
      },
      fallback: { generate: fallback },
      primaryName: 'configured',
      fallbackName: 'other',
    });
    await expect(
      service.generate('private family scene', { privateContent: true }),
    ).rejects.toThrow();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('retains existing fallback for ordinary generation', async () => {
    const fallback = jest.fn().mockResolvedValue(Buffer.from('image'));
    const service = new FallbackImageGenerationService({
      primary: {
        generate: async () => {
          throw new Error('transient');
        },
      },
      fallback: { generate: fallback },
      primaryName: 'configured',
      fallbackName: 'other',
    });
    await expect(service.generate('ordinary scene')).resolves.toEqual(Buffer.from('image'));
    expect(fallback).toHaveBeenCalled();
  });
});
