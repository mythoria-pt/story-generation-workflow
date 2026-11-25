import { describe, expect, it } from '@jest/globals';
import { PREMIUM_EMBEDDED_LETTERING_EDITION } from '@/services/premium-book-contract.js';
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
