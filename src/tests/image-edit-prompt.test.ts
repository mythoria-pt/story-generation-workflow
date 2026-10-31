import { describe, it, expect } from '@jest/globals';
import {
  buildCoverTitleRequest,
  buildCoverTitleSystemPrompt,
  buildImageEditPrompt,
  sanitizeBookTitleForPrompt,
} from '../utils/imageUtils';

const STRICT_RULE = 'No text overlays or watermarks.';

describe('buildImageEditPrompt title lettering', () => {
  it('adds the title block and relaxed text rule when a title is provided', () => {
    const prompt = buildImageEditPrompt(
      'Make the sky purple',
      'watercolor',
      'soft washes',
      false,
      undefined,
      'The Lantern Path',
    );

    expect(prompt).toContain('<title_lettering>');
    expect(prompt).toContain('exact title "The Lantern Path"');
    expect(prompt).toContain('top third');
    expect(prompt).toContain('the title must remain');
    expect(prompt).toContain('No other text, captions or watermarks besides the title.');
    expect(prompt).not.toContain(STRICT_RULE);
  });

  it('keeps the strict no-text rule and no title block without a title', () => {
    const prompt = buildImageEditPrompt('Make the sky purple', 'watercolor');

    expect(prompt).not.toContain('<title_lettering>');
    expect(prompt).toContain(STRICT_RULE);
  });

  it('treats blank or whitespace-only titles as missing', () => {
    for (const title of ['', '   ', '\n\t']) {
      const prompt = buildImageEditPrompt('Edit', undefined, undefined, false, undefined, title);
      expect(prompt).not.toContain('<title_lettering>');
      expect(prompt).toContain(STRICT_RULE);
    }
  });

  it('produces identical output for undefined and blank titles', () => {
    const base = buildImageEditPrompt('Edit', 'style', 'kw', true, 'full');
    const blank = buildImageEditPrompt('Edit', 'style', 'kw', true, 'full', '  ');
    expect(blank).toBe(base);
  });

  it('sanitises straight double quotes so the quoted instruction is not broken', () => {
    const prompt = buildImageEditPrompt(
      'Edit',
      undefined,
      undefined,
      false,
      undefined,
      'The "Great"   Escape',
    );

    expect(prompt).toContain('exact title "The “Great” Escape"');
    expect(prompt).not.toContain('"The "Great"');
  });
});

describe('title request inside edit_request', () => {
  it('appends the title request to the user request', () => {
    const prompt = buildImageEditPrompt(
      'Style conversion',
      undefined,
      undefined,
      false,
      undefined,
      'The Lantern Path',
    );
    expect(prompt).toContain(
      '<edit_request>\nStyle conversion\nLetter the exact book title "The Lantern Path" on the cover, in the top third.\n</edit_request>',
    );
  });

  it('appends the title request to the default text when there is no user request', () => {
    const prompt = buildImageEditPrompt('', undefined, undefined, false, undefined, 'Moon');
    expect(prompt).toContain(
      'without altering its core subjects.\nLetter the exact book title "Moon" on the cover, in the top third.\n</edit_request>',
    );
  });

  it('leaves the edit_request untouched without a title', () => {
    const prompt = buildImageEditPrompt('Make the sky purple');
    expect(prompt).toContain('<edit_request>\nMake the sky purple\n</edit_request>');
    expect(prompt).not.toContain('Letter the exact book title');
  });
});

describe('buildCoverTitleRequest', () => {
  it('builds the request and sanitises quotes', () => {
    expect(buildCoverTitleRequest('The "Great"  Escape')).toBe(
      'Letter the exact book title "The “Great” Escape" on the cover, in the top third.',
    );
  });

  it('returns empty string for empty titles', () => {
    expect(buildCoverTitleRequest('')).toBe('');
    expect(buildCoverTitleRequest('   ')).toBe('');
    expect(buildCoverTitleRequest(undefined)).toBe('');
  });
});

describe('buildCoverTitleSystemPrompt', () => {
  it('builds the system instruction and sanitises quotes', () => {
    const text = buildCoverTitleSystemPrompt('The "Great" Escape');
    expect(text).toContain('titled "The “Great” Escape"');
    expect(text).toContain('top third');
    expect(text).toContain('The title is the only text on the cover.');
  });

  it('returns empty string for empty titles', () => {
    expect(buildCoverTitleSystemPrompt('')).toBe('');
    expect(buildCoverTitleSystemPrompt(null)).toBe('');
    expect(buildCoverTitleSystemPrompt(' \n ')).toBe('');
  });
});

describe('sanitizeBookTitleForPrompt', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeBookTitleForPrompt('  A   Tale \n of  Two ')).toBe('A Tale of Two');
  });

  it('returns empty string for missing input', () => {
    expect(sanitizeBookTitleForPrompt(undefined)).toBe('');
    expect(sanitizeBookTitleForPrompt(null)).toBe('');
    expect(sanitizeBookTitleForPrompt('   ')).toBe('');
  });
});
