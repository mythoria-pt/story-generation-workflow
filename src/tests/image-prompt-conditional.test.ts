import { PromptService } from '@/services/prompt.js';
import { readFile } from 'fs/promises';
import { posix as pathPosix } from 'path';
import { getPromptsPath } from '@/shared/path-utils.js';

describe('Image Prompt Conditional Custom Instructions', () => {
  let frontCoverTemplate: any;

  beforeAll(async () => {
    const promptPath = pathPosix.join(getPromptsPath(), 'images', 'front_cover.json');
    const raw = await readFile(promptPath, 'utf-8');
    frontCoverTemplate = JSON.parse(raw);
  });

  test('includes custom instructions block when provided', () => {
    const result = PromptService.buildPrompt(frontCoverTemplate, {
      bookTitle: 'Test Book',
      promptText: 'A castle on a hill',
      customInstructions: 'Use a warm golden sunset palette.'
    });

    expect(result).toContain('Use a warm golden sunset palette.');
    expect(result).not.toContain('{{#customInstructions}}');
    expect(result).not.toContain('{{/customInstructions}}');
  });

  test('removes custom instructions block entirely when empty', () => {
    const result = PromptService.buildPrompt(frontCoverTemplate, {
      bookTitle: 'Test Book',
      promptText: 'A castle on a hill',
      customInstructions: ''
    });

    expect(result).not.toContain('<custom_instructions>');
    expect(result).not.toContain('{{#customInstructions}}');
  });
});
