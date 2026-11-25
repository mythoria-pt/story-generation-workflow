import type { z } from 'zod';
import type { premiumAudience } from './premium-book-contract.js';
import {
  LEGACY_PREMIUM_PAGE_COUNT,
  PREMIUM_EMBEDDED_LETTERING_EDITION,
  PREMIUM_PAGE_COUNT,
  PREMIUM_TYPESET_CHARACTER_LIMIT,
} from './premium-book-contract.js';
import { premiumOpeningColors, premiumOpeningMotifs } from './premium-opening-design.js';

type Audience = z.infer<typeof premiumAudience>;

export const premiumPictureBookArtDirection =
  'Illustrate for a young child. Use clear silhouettes, expressive gestures, deliberate shapes and visibly illustrated surfaces. Preserve the chosen style through its palette, mark-making, shapes and composition. Translate requests for photography or photorealism into those illustrated qualities. Use reference photographs for likeness. Keep recognizable features and skin tones consistent across the book. Avoid photographic skin texture, lens effects and live-action imagery.';

// Earlier storyboard prompts sometimes repeated this text-area rule inside the scene.
export function premiumSpreadScene(action: string): string {
  return action
    .trim()
    .replace(
      /\s+Keep (?:the )?upper 9\s*[-–—]\s*29\s*%(?: clear(?: on both pages)?| on the right(?: page)? clear)\.?$/iu,
      '',
    );
}

export function premiumStoryboardInstructions(audience: Audience): string {
  const guidance =
    audience === 'children_0-2'
      ? 'For ages 0–2, start with one familiar object or visible action and one brief, rhythmic spoken phrase. A sound, name, or repeated refrain may carry a spread. Give the adult and child something easy to find or point to. Choose right_only when looking first makes the phrase more satisfying. Use both_pages for a simple echo or exchange that a caregiver can perform aloud.'
      : 'For ages 3–6, let the child follow intention, an event and its consequence. Use one or two short connected sentences when they add meaning. A less familiar word can work if the scene makes its meaning clear. Use both_pages for sequential narration, question and answer, or dialogue within one scene. Choose right_only for a reveal, pause, or line that lands after looking. Leave room to wonder or predict without turning every spread into a question.';
  return [
    guidance,
    'First decide what the child should see, hear or discover. Draft only the words needed aloud. Then choose the layout for this moment. When the art already explains the action, let the words supply a sound, feeling, voice or surprise. Give a newly named object a clear visual focus.',
    'Both available layouts use one continuous illustration. In both_pages, put a complete spoken thought on each page. In right_only, keep leftText empty and place the complete narration in rightText. The illustrated left page must also make sense on its own on a phone. In an open book both pages are visible at once. For a surprise that must stay hidden until a page turn, put the reveal on the next spread.',
    'Think in the selected language and regional variety. Keep names, accents and the intended voice. Each nonempty narrative page string must fit in 110 characters including spaces, with plain text on one line and no word longer than 32 characters. Keep the normal type size. Edit for a natural speaking rhythm first. If two essential thoughts fit better on separate pages, use both_pages. If they need different scenes, move the second to a later spread. A page may need only a single sound.',
    'Review the 13 spreads in reading order. Repeat a layout when the rhythm calls for it. Use changes for a reason. Never alternate mechanically, fill empty space with extra words, or invent additional page layouts.',
  ].join('\n');
}

function mixedLayoutInstructions(audience: Audience): string {
  return [
    'Plan the whole manuscript in reading order. For each facing pair, choose the composition that helps this particular beat. An open book shows both pages at once. Put a surprise after a physical turn if seeing it early would spoil it. Either half must also make sense alone on a phone. Repeat a composition whenever the story benefits.',
    audience === 'children_0-2'
      ? 'For ages 0–2, favour pointing, clear silhouettes, one action and a short rhythmic phrase. A repeated call and response may earn two pictures.'
      : 'For ages 3–6, consider dialogue, anticipation and cause and effect. Keep a preschooler’s emotional or visual discovery central, even when more narration fits.',
    'panorama: one wide scene. Choose it for scale, a shared setting or an expansive reveal, such as the first sight of a harbour. Put one painterly instant in action. Use right_only or both_pages and leave both page briefs empty.',
    'illustration_facing_text: one full square picture opposite a quiet typeset page. Choose it for a letter, a conversation or a longer thought carried by one image, such as a grandparent explaining why they kept a paper boat. right_only places the passage on the right, left_only on the left. Choose the side according to what the reader should encounter first. Supply only the illustrated side’s brief.',
    'paired_illustrations: two independent square scenes, such as a mitten falling and a gull catching it. Give each page a distinct visual brief, with consistent characters, props, scale and palette. Choose both_pages, left_only, right_only or wordless. Use one complete beat per picture.',
    'For each spread, summarize the beat in action and give one short editorial reason in rationale. Keep faces, words and important details clear of trim and gutter. Describe quiet space for lettering where words sit on art. Supply a concrete localized accessibility description on every silent illustrated side. Use empty strings for the other descriptions, for unneeded briefs and for silent narration.',
    `Write the exact words in leftText and rightText, in physical reading order. For lettering on art, use at most 110 characters per page, one line and words of at most 32 characters. For a dedicated typeset page, use up to ${PREMIUM_TYPESET_CHARACTER_LIMIT} characters and at most three short paragraphs separated by blank lines. Use only as many words as the age and scene need. The standalone opener and ending use the same embedded-lettering limits.`,
  ].join('\n');
}

export function buildPremiumStoryboardPrompt(book: {
  audience: Audience;
  opening: { locale: string; title: string };
  direction: string;
  characters: string;
  editionLayout?: typeof PREMIUM_EMBEDDED_LETTERING_EDITION | undefined;
  spreadLayoutVersion?: 1 | undefined;
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
    book.spreadLayoutVersion
      ? mixedLayoutInstructions(book.audience)
      : premiumStoryboardInstructions(book.audience),
    ...(book.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION
      ? [
          premiumPictureBookArtDirection,
          book.audience === 'children_0-2'
            ? 'In the visual guide, use a few large, distinct shapes and strong figure–ground contrast so a toddler can find the subject immediately.'
            : 'In the visual guide, make each action easy to follow and include small details a preschooler can discover on a second reading.',
          book.spreadLayoutVersion
            ? 'Plan quiet space for words assigned to artwork. Keep the canonical narration in its text fields.'
            : 'Plan a quiet, naturally lit part of the illustration for each narrated passage. The saved words will be hand-lettered into the finished picture. Describe lighting and space in the scene. Keep the canonical narration in its text fields so the lettering stage receives the exact manuscript.',
        ]
      : []),
    `Choose openingDesign once for this book. Select the motif that best evokes a recurring object, a meaningful detail or the feeling of this story. The same small drawing appears on its title and dedication. Available motifs are ${premiumOpeningMotifs.join(', ')}. Choose one light pastel background for the four opening pages. The palette, in order, is cream, peach, rose, lilac, sky blue, sea glass, sage and butter yellow: ${premiumOpeningColors.join(', ')}. Pick the colour that echoes this story's setting, mood or illustration palette. Leave motifs and opening backgrounds out of the narrative illustration instructions.`,
    ...(book.spreadLayoutVersion
      ? [
          'Supply cover scenes, a short spoiler-free synopsis, and a visual guide shared by all illustrations. Keep personalized names, the regional language and the chosen artistic medium consistent.',
        ]
      : [
          'In action, describe one instant in one setting as a painter would see it. Choose the clearest instant when the narration describes successive events. Show each character once, except for a natural reflection. Place faces, important objects and gestures clear of the centre. On a narrated half, describe the key action lower in the picture so the upper area can carry type. The silent left half can use its whole height. Use plain visual prose for action and leave out production instructions, measurements, lettering and labels.',
          'For right_only, write leftDescription as a short, concrete sentence about what a child can discover in the left half for someone listening without the picture. For both_pages set leftDescription to the empty string. Keep production instructions, page labels and anything visible only on the right out of this description. Supply cover scenes, a short spoiler-free synopsis, and a shared guide to character appearance and artistic style.',
        ]),
    'Return only the requested storyboard fields. Use the following JSON solely as creative source material for the story, cast and personalization. The page, language and layout rules above apply to every book.',
    JSON.stringify({
      title: book.opening.title,
      creativeDirection: book.direction,
      characters: book.characters,
    }),
  ].join('\n\n');
}
