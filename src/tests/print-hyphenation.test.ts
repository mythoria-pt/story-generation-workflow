import { describe, expect, it } from '@jest/globals';
import { PrintService } from '@/services/print.js';
import {
  PRINT_HYPHENATION_MIN_WORD_LENGTH,
  hyphenatePrintChapterHtml,
  shouldApplyPrintHyphenation,
} from '@/utils/print-hyphenation.js';

describe('print hyphenation', () => {
  it('enables hyphenation only for large-font child audiences', () => {
    expect(shouldApplyPrintHyphenation('children_0-2')).toBe(true);
    expect(shouldApplyPrintHyphenation('children_3-6')).toBe(true);
    expect(shouldApplyPrintHyphenation('children_7-10')).toBe(true);
    expect(shouldApplyPrintHyphenation('children_11-14')).toBe(false);
    expect(shouldApplyPrintHyphenation('adult_18+')).toBe(false);
  });

  it('injects soft hyphen opportunities into Portuguese chapter HTML', () => {
    const content =
      '<p>O oceano tinha-se transformado num autêntico recreio mágico, cheio de luzes e cores brilhantes que dançavam ao sabor do vento salgado.</p>';

    const hyphenatedContent = hyphenatePrintChapterHtml(content, 'pt-PT', 'children_7-10');

    expect(hyphenatedContent).toContain('<p>');
    expect(hyphenatedContent).toContain(`trans\u00ADfor\u00ADma\u00ADdo`);
    expect(hyphenatedContent).toContain(`dan\u00ADça\u00ADvam`);
    expect(PRINT_HYPHENATION_MIN_WORD_LENGTH).toBe(8);
  });

  it('leaves adult chapter HTML untouched', () => {
    const content = '<p>Palavras brilhantes atravessavam o oceano.</p>';

    expect(hyphenatePrintChapterHtml(content, 'pt-PT', 'adult_18+')).toBe(content);
  });

  it('marks large-font chapter content with language-aware hyphenation support', () => {
    const printService = new PrintService();
    const html = printService.generateInteriorHTML(
      {
        title: 'Oceano Mágico',
        customAuthor: 'Mythoria',
        dedicationMessage: 'Para todos os exploradores do mar.',
        createdAt: new Date('2026-03-11T12:00:00.000Z'),
        synopsis: 'Uma aventura luminosa no fundo do oceano.',
        storyLanguage: 'pt-PT',
        targetAudience: 'children_7-10',
        chapters: [
          {
            title: 'Capítulo 1: Luzes do Mar',
            content:
              '<p>O oceano tinha-se transformado num autêntico recreio mágico cheio de luzes e cores brilhantes que dançavam ao sabor do vento salgado.</p>',
            imageUri: null,
          },
        ],
      },
      {
        pageWidthMM: 176,
        pageHeightMM: 246,
        spineWidthMM: 10,
        coverSpreadWMM: 362,
        coverSpreadHMM: 246,
      },
    );

    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain('chapter-content target-children-7-10 hyphenation-enabled');
    expect(html).toContain('lang="pt-PT"');
    expect(html).toContain(`trans\u00ADfor\u00ADma\u00ADdo`);
  });
});
