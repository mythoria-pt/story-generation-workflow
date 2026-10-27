import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { booleanFlagSchema } from '../config/environment';

describe('TTS_EXPRESSIVE_DIRECTION_ENABLED parsing', () => {
  it.each([
    ['true', true],
    [' TRUE ', true],
    ['True', true],
    ['1', true],
    ['false', false],
    [' False ', false],
    ['0', false],
    ['', false],
    ['   ', false],
    [undefined, false],
  ])('parses %p as %p', (input, expected) => {
    expect(booleanFlagSchema.parse(input)).toBe(expected);
  });

  it('rejects other values, and the JSON schema pattern agrees', () => {
    expect(booleanFlagSchema.safeParse('yes').success).toBe(false);
    const schema = JSON.parse(readFileSync(join(process.cwd(), '.env.schema.json'), 'utf8'));
    const pattern = new RegExp(schema.properties.TTS_EXPRESSIVE_DIRECTION_ENABLED.pattern);
    for (const ok of ['true', ' TRUE ', '1', '0', 'False', '']) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of ['yes', 'on', '2']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });
});
