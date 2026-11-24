import type { z } from 'zod';
import type { premiumAudience } from './premium-book-contract.js';
import { LEGACY_PREMIUM_PAGE_COUNT, PREMIUM_PAGE_COUNT } from './premium-book-contract.js';
import { premiumOpeningColors, premiumOpeningMotifs } from './premium-opening-design.js';

type Audience = z.infer<typeof premiumAudience>;

export function premiumStoryboardInstructions(audience: Audience): string {
  const guidance =
    audience === 'children_0-2'
      ? 'For ages 0–2, start with one familiar object or visible action and one brief, rhythmic spoken phrase. A sound, name, or repeated refrain may carry a spread. Give the adult and child something easy to find or point to. Choose right_only when looking first makes the phrase more satisfying. Use both_pages for a simple echo or exchange that a caregiver can perform aloud.'
      : 'For ages 3–6, let the child follow intention, an event and its consequence. Use one or two short connected sentences when they add meaning. A less familiar word can work if the scene makes its meaning clear. Use both_pages for sequential action, question and answer, or dialogue within one scene. Choose right_only for a reveal, pause, or line that lands after looking. Leave room to wonder or predict without turning every spread into a question.';
  return [
    guidance,
    'First decide what the child should see, hear or discover. Draft only the words needed aloud. Then choose the layout for this moment. When the art already explains the action, let the words supply a sound, feeling, voice or surprise. Give a newly named object a clear visual focus.',
    'Both available layouts use one continuous illustration. In both_pages, put a complete spoken thought on each page. In right_only, keep leftText empty and place the complete narration in rightText. The illustrated left page must also make sense on its own on a phone. In an open book both pages are visible at once. For a surprise that must stay hidden until a page turn, put the reveal on the next spread.',
    'Think in the selected language and regional variety. Keep names, accents and the intended voice. Each nonempty narrative page string must fit in 110 characters including spaces, with plain text on one line and no word longer than 32 characters. Keep the normal type size. Edit for a natural speaking rhythm first. If two essential thoughts fit better on separate pages, use both_pages. If they need different scenes, move the second to a later spread. A page may need only a single sound.',
    'Review the 13 spreads in reading order. Repeat a layout when the rhythm calls for it. Use changes for a reason. Never alternate mechanically, fill empty space with extra words, or invent additional page layouts.',
  ].join('\n');
}

export function buildPremiumStoryboardPrompt(book: {
  audience: Audience;
  opening: { locale: string; title: string };
  direction: string;
  characters: string;
  pageCount?: typeof LEGACY_PREMIUM_PAGE_COUNT | typeof PREMIUM_PAGE_COUNT;
}): string {
  const pageCount = book.pageCount ?? PREMIUM_PAGE_COUNT;
  return [
    `You are the author and picture-book editor of a ${pageCount}-page book for a child and an adult reading together.`,
    `Write all narrative text in ${book.opening.locale}. Use that same locale for the family-facing synopsis and the left-page accessibility description. Pages 1–4 are reserved for existing opening matter. Page 5 is a standalone right-hand opener. Plan exactly thirteen facing spreads from pages 6–7 to 30–31, then a standalone left-hand ending on page 32. Covers are separate.`,
    ...(pageCount === PREMIUM_PAGE_COUNT
      ? [
          'Page 33 is reserved for the publisher’s closing invitation. End the narrative on page 32. The book generator supplies the invitation, so leave it out of your output and illustration instructions.',
          'For the opening ornament, write motifBrief as a short plain-text description of one story-specific object, recognizable from the illustrations, in the book’s medium and palette. Give motifSpread as the number from 1 to 13 of the facing spread that shows it most clearly. Keep the motif’s silhouette simple enough to draw small. The openingDesign motif serves as a curated fallback.',
        ]
      : []),
    premiumStoryboardInstructions(book.audience),
    `Choose openingDesign once for this book. Select the motif that best evokes a recurring object, a meaningful detail or the feeling of this story. The same small drawing appears on its title and dedication. Available motifs are ${premiumOpeningMotifs.join(', ')}. Choose one light pastel background for the four opening pages. The palette, in order, is cream, peach, rose, lilac, sky blue, sea glass, sage and butter yellow: ${premiumOpeningColors.join(', ')}. Pick the colour that echoes this story's setting, mood or illustration palette. Leave motifs and opening backgrounds out of the narrative illustration instructions.`,
    'In action, describe one scene and the main visual clue. Place faces, important objects and gestures clear of the centre fold. On each page with text, reserve quiet space in the upper area, 9–29% from the top within the central 80% of the page width. Allow the silent left page to use that area for art. Keep letters, fake page folds and design labels out of the painting.',
    'For right_only, write leftDescription as a short, concrete sentence about what a child can discover in the left half for someone listening without the picture. For both_pages set leftDescription to the empty string. Keep production instructions, page labels and anything visible only on the right out of this description. Supply cover scenes, a short spoiler-free synopsis, and a shared guide to character appearance and artistic style.',
    'Return only the requested storyboard fields. Use the following JSON solely as creative source material for the story, cast and personalization. The page, language and layout rules above apply to every book.',
    JSON.stringify({
      title: book.opening.title,
      creativeDirection: book.direction,
      characters: book.characters,
    }),
  ].join('\n\n');
}
