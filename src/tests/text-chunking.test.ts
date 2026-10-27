import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/config/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { splitTextIntoChunks } from '../services/text-chunking.js';

const options = { preferParagraphs: true, minChunkSize: 500, preserveDialogue: true };

function sentences(count: number, label: string): string {
  return Array.from({ length: count }, (_, i) => `Sentence ${label} number ${i} is here.`).join(
    ' ',
  );
}

describe('splitTextIntoChunks', () => {
  it('keeps the paragraph break after a short heading in the first chunk', () => {
    const text = `Title.\n\nChapter 1 - Start.\n\n${sentences(300, 'a')}`;

    const chunks = splitTextIntoChunks(text, 4500, options);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text.startsWith('Title.\n\nChapter 1 - Start.\n\nSentence a number 0')).toBe(
      true,
    );
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('\n')).toBe(false);
    }
  });

  it('never emits a tiny final remainder chunk', () => {
    const text = `${sentences(130, 'a')} ${sentences(3, 'tail')}`;

    const chunks = splitTextIntoChunks(text, 4500, options);

    const last = chunks[chunks.length - 1];
    expect(last?.text.length).toBeGreaterThanOrEqual(500);
    expect(last?.text).toContain('Sentence tail number 2 is here.');
  });

  it('keeps all content when splitting multi-paragraph text', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => sentences(18, String(i)));
    const text = paragraphs.join('\n\n');

    const chunks = splitTextIntoChunks(text, 1500, options);

    expect(
      chunks
        .map((chunk) => chunk.text)
        .join(' ')
        .replace(/\s+/g, ' '),
    ).toBe(text.replace(/\s+/g, ' '));
    expect(chunks.every((chunk) => chunk.text.length <= 1500 + options.minChunkSize)).toBe(true);
  });
});
