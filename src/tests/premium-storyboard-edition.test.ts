import { describe, expect, it } from '@jest/globals';
import {
  PREMIUM_EMBEDDED_LETTERING_EDITION,
  mixedGeneratedPremiumBoard,
  premiumPageRenderMode,
} from '@/services/premium-book-contract.js';
import {
  buildPremiumStoryboardPrompt,
  premiumPictureBookArtDirection,
} from '@/services/premium-book-storyboard.js';

const examples = [
  ['en-US', 'The Rainy-Day Parade', 'paper collage'],
  ['pt-PT', 'O Caracol e a Poça', 'fotografia'],
  ['es-ES', '¿Dónde está mi cometa?', 'acuarela'],
  ['fr-FR', 'L’Île aux étoiles', 'fusain'],
  ['de-DE', 'Fünf Füchse im Schnee', 'Fotorealismus'],
] as const;

describe('mixed spread vocabulary', () => {
  const schema = mixedGeneratedPremiumBoard.shape.spreads.element;
  const passage = {
    composition: 'illustration_facing_text',
    textLayout: 'left_only',
    action: 'A gull watches the harbour.',
    rationale: 'Read the letter before seeing its sender.',
    leftText: '«Olá, avó!»\n\nO vento trouxe uma carta.',
    rightText: '',
    leftBrief: '',
    rightBrief: 'A gull carries an envelope.',
    leftDescription: '',
    rightDescription: 'Uma gaivota leva uma carta.',
  };
  it('keeps longer passages and embedded lines in their assigned page roles', () => {
    expect(schema.safeParse(passage).success).toBe(true);
    expect(premiumPageRenderMode('illustration_facing_text', 'left_only', 'left')).toBe('typeset');
    expect(schema.safeParse({ ...passage, rightText: 'Outra vez.' }).success).toBe(false);
    expect(
      schema.safeParse({
        ...passage,
        composition: 'paired_illustrations',
        leftBrief: 'The wind picks up.',
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...passage, textLayout: 'both_pages' }).success).toBe(false);
  });
  it('permits two silent illustrated beats with two briefs and two descriptions', () => {
    const pair = {
      ...passage,
      composition: 'paired_illustrations',
      textLayout: 'wordless',
      leftText: '',
      leftBrief: 'A red mitten falls.',
      leftDescription: 'Uma luva vermelha cai.',
    };
    expect(schema.safeParse(pair).success).toBe(true);
    expect(schema.safeParse({ ...pair, rightBrief: '' }).success).toBe(false);
    expect(schema.safeParse({ ...pair, rightDescription: '' }).success).toBe(false);
  });
});

describe.each(['children_0-2', 'children_3-6'] as const)('new picture books for %s', (audience) => {
  it.each(examples)('preserves the language and visual brief for %s', (locale, title, style) => {
    const book = { audience, opening: { locale, title }, direction: style, characters: '' };
    const prompt = buildPremiumStoryboardPrompt({
      ...book,
      editionLayout: PREMIUM_EMBEDDED_LETTERING_EDITION,
    });
    expect(prompt).toContain(`Write all narrative text in ${locale}.`);
    expect(prompt).toContain(premiumPictureBookArtDirection);
    expect(prompt).toContain(audience === 'children_0-2' ? 'a toddler' : 'a preschooler');
    expect(prompt).toContain('right_only');
    expect(prompt).toContain('both_pages');
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))).toMatchObject({
      title,
      creativeDirection: style,
    });
    expect(buildPremiumStoryboardPrompt(book)).not.toContain(premiumPictureBookArtDirection);
  });
});
