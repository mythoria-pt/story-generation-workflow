import { describe, it, expect } from '@jest/globals';
import { ImageGenerationMiddleware } from '../ai/token-tracking-middleware';

const context = { authorId: 'author', storyId: 'story', action: 'image_edit' } as never;

describe('ImageGenerationMiddleware.supportsEdit', () => {
  it('is false when the base service only implements generate()', () => {
    const base = { generate: async () => Buffer.from('x') };
    expect(new ImageGenerationMiddleware(base as never, context).supportsEdit()).toBe(false);
  });

  it('is true when the base service implements edit()', () => {
    const base = {
      generate: async () => Buffer.from('x'),
      edit: async () => Buffer.from('y'),
    };
    expect(new ImageGenerationMiddleware(base as never, context).supportsEdit()).toBe(true);
  });
});
