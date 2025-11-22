import { buildTranslatePrompt, cleanAITextOutput, normalizeSlug } from '@/services/translation.js';

describe('translation helpers', () => {
  it('normalizes slugs to lowercase kebab-case', () => {
    expect(normalizeSlug('Olá Mundo! 2024')).toBe('ola-mundo-2024');
    expect(normalizeSlug('  Multi---Space__Slug  ')).toBe('multi-space-slug');
  });

  it('strips markdown fences from AI output', () => {
    const fenced = '```markdown\nConteúdo traduzido\n```';
    expect(cleanAITextOutput(fenced)).toBe('Conteúdo traduzido');
  });

  it('embeds locale metadata into translate prompts', async () => {
    const prompt = await buildTranslatePrompt('pt-PT', {
      contentType: 'slug',
      originalText: 'autumn tales',
      storyTitle: 'Autumn Tales',
      sourceLocale: 'en-US',
    });
    expect(prompt).toContain('pt-PT');
    expect(prompt).toContain('autumn tales');
    expect(prompt).toContain('slug');
  });
});
