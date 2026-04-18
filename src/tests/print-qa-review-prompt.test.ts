import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';

describe('print-qa-review prompt', () => {
  it('treats standard chapter drop-cap spacing as intentional', () => {
    const prompt = JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'prompts', 'print-qa-review.json'), 'utf-8'),
    ) as {
      systemPrompt: string;
      userPrompt: string;
    };

    expect(prompt.systemPrompt).toContain('standard chapter drop-cap styling as intentional');
    expect(prompt.systemPrompt).toContain('normal optical gap');
    expect(prompt.userPrompt).toContain(
      'Do not flag the normal spacing created by the first-paragraph drop cap',
    );
  });
});
