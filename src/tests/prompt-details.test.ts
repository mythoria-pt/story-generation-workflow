import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PromptService } from '../services/prompt';
import type { PromptTemplate } from '../services/prompt';

/**
 * Guards the data-flow fix: author "additional requests / special details" and the
 * synopsis must reach the outline + chapter prompts, and the conditional block must
 * disappear cleanly when no additional requests were provided.
 */
function loadRealPrompt(name: 'text-outline' | 'text-chapter'): PromptTemplate {
  const file = join(process.cwd(), 'src', 'prompts', 'en-US', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as PromptTemplate;
}

describe('story prompts preserve author details', () => {
  it('outline prompt renders additionalRequests + synopsis when provided', () => {
    const tmpl = loadRealPrompt('text-outline');
    const { userPrompt } = PromptService.buildParts(tmpl, {
      synopsis: 'A boy and his dog cross the mountains.',
      additionalRequests: 'Include a red balloon and the grandmother named Ana.',
    });

    expect(userPrompt).toContain('A boy and his dog cross the mountains.');
    expect(userPrompt).toContain('<additional_requests>');
    expect(userPrompt).toContain('Include a red balloon and the grandmother named Ana.');
  });

  it('outline prompt omits the additional_requests block when empty', () => {
    const tmpl = loadRealPrompt('text-outline');
    const { userPrompt } = PromptService.buildParts(tmpl, {
      synopsis: '',
      additionalRequests: '',
    });

    expect(userPrompt).not.toContain('<additional_requests>');
  });

  it('chapter prompt renders additionalRequests when provided', () => {
    const tmpl = loadRealPrompt('text-chapter');
    const { userPrompt } = PromptService.buildParts(tmpl, {
      additionalRequests: 'The dog must always wear a blue collar.',
    });

    expect(userPrompt).toContain('<additional_requests>');
    expect(userPrompt).toContain('The dog must always wear a blue collar.');
  });

  it('chapter prompt omits the additional_requests block when empty', () => {
    const tmpl = loadRealPrompt('text-chapter');
    const { userPrompt } = PromptService.buildParts(tmpl, { additionalRequests: '' });

    expect(userPrompt).not.toContain('<additional_requests>');
  });
});
