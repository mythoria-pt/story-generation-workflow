import { describe, it, expect } from '@jest/globals';
import { countWords } from '@/shared/utils';

describe('countWords utility', () => {
  it('should correctly count words in a string', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('  multiple   spaces\nbetween words ')).toBe(4);
    expect(countWords('')).toBe(0);
  });
});
