import type { z } from 'zod';
import type { premiumAudience } from './premium-book-contract.js';
import {
  premiumPictureBookArtDirection,
  premiumSimpleSceneDirection,
} from './premium-book-storyboard.js';

export type PremiumLetteredPage = {
  side: 'left' | 'right';
  text: string;
};
export const PREMIUM_PROOF_LETTERING_INSET = 0.12;
const proofLetteringClearance = `Keep every glyph, accent and flourish at least ${PREMIUM_PROOF_LETTERING_INSET * 100}% from every edge of the visible trim. Keep the surrounding area uninterrupted and do not reduce readability to make it fit.`;

export function premiumLetteredPageReferences(cast: Buffer, guideCrop?: Buffer): Buffer[] {
  return [guideCrop ?? cast];
}

export const premiumCoverComposition =
  'Envision an 8.5-inch square casewrap cover. Extend the background to every edge and allow generous quiet space at the top and bottom for separately typeset title or synopsis. Keep essential content away from the edges and binding.';

export const premiumSingleSceneDirection =
  'Show each physical character and distinctive story prop only once anywhere in the full spread. A natural reflection is allowed when it clearly belongs to that character or prop in the same scene. If the scene describes successive moments, choose one drawable instant in one coherent setting. Convey earlier or later beats through a gesture, a prop, a visual clue or visible aftermath. Do not repeat the people or stage separate panels to show more of the story.';

export function buildPremiumNativeCoverPrompt({
  guide,
  action,
}: {
  guide: string;
  action: string;
}) {
  return [
    "Paint one continuous full-bleed square children's picture-book cover.",
    premiumPictureBookArtDirection,
    'Preserve the selected illustration medium and the character likeness in the supplied reference.',
    premiumCoverComposition,
    'Never render text, letters, numerals, logos, labels or signatures. Background must reach every edge. Preserve visual consistency with the reference illustrations.',
    `Visual guide: ${guide}`,
    `Cover scene: ${action}`,
  ].join('\n');
}

export function buildPremiumDesignCoverPrompt({
  side,
  guide,
  scene,
  title,
  locale,
  correction,
  artDirectionVersion,
}: {
  side: 'front' | 'back';
  guide: string;
  scene: string;
  title: string;
  locale: string;
  correction: boolean;
  artDirectionVersion?: 1 | undefined;
}) {
  return [
    'Paint one square, full-bleed children’s picture-book cover. Keep all essential details well inside the trim and away from the binding. Show the cover artwork directly with no border, book mockup or panels.',
    premiumPictureBookArtDirection,
    premiumSimpleSceneDirection,
    ...(correction
      ? [
          'The first reference is the current cover. Preserve its unmentioned illustration details and follow the stated cover treatment.',
        ]
      : []),
    side === 'front'
      ? [
          `Paint the following ${locale} book title into the art exactly once as large, clear hand lettering. Give it a calm, high-contrast background, readable line breaks and generous safe margins. Preserve every name, accent, capital and punctuation mark. Include no other writing, numbers, logos or labels. The brackets below mark the title input and do not belong in the artwork.`,
          ...(artDirectionVersion ? [proofLetteringClearance] : []),
          '<title>',
          title,
          '</title>',
        ].join('\n')
      : 'Keep the artwork entirely wordless and free of letters, numerals, marks resembling writing, labels, logos and watermarks. Reserve a quiet rectangle of uninterrupted background in the lower-left safe area for a publisher mark applied later. Do not draw an outline or placeholder around it.',
    `Visual style and likeness guide: ${guide}`,
    `Cover scene: ${scene}`,
  ].join('\n');
}

const letteringStyle =
  'Paint the narration directly in the illustration as warm, childlike hand lettering with rounded, easily recognized letterforms. Use generous spacing, clear high contrast, and at most one playful accent of size or colour when the meaning calls for it. Keep the baseline and reading order easy to follow. Make the words large enough to read aloud from a small picture book. Use calm scenery or an open patch of the scene behind the words; keep scenery, faces and gestures clear of the lettering.';

export function buildPremiumLetteredPagePrompt({
  side,
  text,
  action,
  guide,
  facing,
  feedback,
  audience,
  locale,
  independent,
  hasPrior,
  generationDesignVersion,
  artDirectionVersion,
}: PremiumLetteredPage & {
  action: string;
  guide: string;
  facing?: boolean | undefined;
  feedback?: string | undefined;
  audience?: z.infer<typeof premiumAudience> | undefined;
  locale?: string | undefined;
  hasPrior?: boolean | undefined;
  generationDesignVersion?: 1 | undefined;
  artDirectionVersion?: 1 | undefined;
  independent?:
    | { correctionInstructions?: string | undefined; hasPrior: boolean; hasNeighbour: boolean }
    | undefined;
}) {
  return [
    'Paint a finished square, full-bleed page for a children’s picture book. Carry its setting all the way to every canvas edge. Do not paint a book mockup, a page border, a panel, a page number, a gutter or a shadow implying a fold.',
    ...(generationDesignVersion && !facing ? [premiumSimpleSceneDirection] : []),
    facing
      ? [
          `Paint only the ${side} half of one continuous illustration. The attached image is the authoritative square crop for that half and includes the bleed. Match its subjects, positions, scale, perspective, light and colours. Keep every subject confined to the part shown in this crop. Any character, prop or place named in the narration only belongs in the illustration if it already appears in this crop.`,
          `Keep a prop or stretch of scenery crossing the ${side === 'left' ? 'right' : 'left'} binding edge cut off at exactly the same place. Carry it beyond the canvas edge. Do not move it inward, complete it or redraw the whole scene on this page.`,
          'Repaint the visible crop at the requested native size with convincing brush detail. Keep essential faces, gestures and clues inside safe trim and clear of the binding.',
          'If this crop shows calm sky, foliage or background reserved for narration with no characters in it, keep it free of characters—do not invent, add or repeat any character, animal or scene mentioned in the narration or shown on the other half of the spread.',
        ].join(' ')
      : 'Paint a single clear moment across the page. Use the character sheet for likeness and visual style. Leave every important expression, gesture and clue safely inside the visible trim.',
    premiumPictureBookArtDirection,
    ...(independent
      ? [
          'This illustration occupies a complete standalone page. The facing page is a separate composition. Keep essential details clear of all trim edges, including the edge next to the binding.',
          'The first attached image is the character and style sheet. Follow its medium, palette and established likenesses.',
          ...(independent.hasPrior
            ? [
                'The second attached image is the current illustration for this page. Retain its staging, recurring characters and story details except where the request changes them. Replace any existing writing with the pinned narration or remove it from a silent page.',
              ]
            : []),
          ...(independent.hasNeighbour
            ? [
                generationDesignVersion
                  ? 'The final attached image is a separately composed neighbouring page. Match its medium and the appearance of any characters or props that this page’s own brief calls for.'
                  : 'The final attached image is a separately composed neighbouring page. Match its relevant props, characters and medium. Keep the event and staging specific to this page.',
              ]
            : []),
          ...(independent.correctionInstructions
            ? [
                `Apply this requested correction to this page: ${independent.correctionInstructions}`,
              ]
            : []),
        ]
      : []),
    ...(hasPrior && !independent
      ? [
          'Use the second image as the current illustration. Preserve all unmentioned staging and details. Render only the pinned narration supplied below.',
        ]
      : []),
    ...(audience === 'children_0-2'
      ? [
          facing
            ? 'For ages 0–2, keep the visual focus already shown in this crop clean and uncluttered, and give any words simple, open shapes.'
            : 'For ages 0–2, let one large, familiar visual focus and an easy-to-point-at action anchor the page. Give the words simple, open shapes.',
        ]
      : audience === 'children_3-6'
        ? [
            facing
              ? 'For ages 3–6, keep the existing crop’s details clear and readable without adding any new characters, animals or story scenes.'
              : 'For ages 3–6, make the character’s action instantly clear and leave a small visual discovery that supports the story.',
          ]
        : []),
    ...(text
      ? [
          letteringStyle,
          ...(artDirectionVersion
            ? [
                proofLetteringClearance,
                'Plan natural short lines inside this area. Keep all words and lettering decorations clear of the spine-side trim, including on a narrow crop.',
                ...(locale === 'pt-PT'
                  ? [
                      'Check each Portuguese accent mark individually at print size. Copy accented letters such as á, ú, ã, â and ç exactly where they occur.',
                    ]
                  : []),
              ]
            : []),
          facing
            ? 'Keep every letter, accent and decorative emphasis mark inside the central 76% of the visible trimmed page, leaving at least 12% empty margin from every edge (including the bleed outside the trim). Leave a generous empty band of background above the first line of text—roughly the height of one to two lines of lettering. Preserve the attached crop faithfully: paint only the hand lettering into the calm background already shown in this crop, without adding characters, animals or new foreground elements beneath the words. Keep decorative strokes or sparkles strictly beside or below the words, never poking into the top or side margins. Give the binding extra breathing room. Do not put the words in a separate opaque panel, banner, speech bubble or pasted label.'
            : 'Keep every letter, accent and decorative emphasis mark inside the central 76% of the visible trimmed page, leaving at least 12% empty margin from every edge (including the bleed outside the trim). Leave a generous empty band of background above the first line of text—roughly the height of one to two lines of lettering—and place the main characters in the lower two-thirds when text sits above them. Keep decorative strokes or sparkles strictly beside or below the words, never poking into the top or side margins. Give the binding extra breathing room. Do not put the words in a separate opaque panel, banner, speech bubble or pasted label.',
          'Render only the following narration, exactly once, including accents, capitalization and punctuation. Use line breaks between words when needed. Do not copy the delimiters into the artwork, add quotation marks, paraphrase, translate, omit a word or add discretionary hyphens.',
          ...(locale
            ? [`Preserve spelling and accents from the supplied ${locale} narration.`]
            : []),
          '<narration>',
          text,
          '</narration>',
        ]
      : [
          'The page is silent. Keep it completely free of letters, numerals, labels and marks that resemble writing.',
        ]),
    'Do not paint any additional words, letters, numbers, signatures, logos or watermarks, including on objects in the scene.',
    ...(facing ? [] : [`Shared visual guide: ${guide}`, `Scene: ${action}`]),
    ...(feedback ? [`Address these findings on the ${side} page: ${feedback}`] : []),
  ].join('\n');
}

export function buildPremiumLetteredPanoramaPrompt({
  action,
  guide,
  leftDescription,
  rightDescription,
  silentLeft,
  silentRight,
  generationDesignVersion,
  artDirectionVersion,
}: {
  action: string;
  guide: string;
  leftDescription?: string | undefined;
  rightDescription?: string | undefined;
  silentLeft?: boolean;
  silentRight?: boolean;
  generationDesignVersion?: 1 | undefined;
  artDirectionVersion?: 1 | undefined;
}) {
  return [
    'Paint a reference panorama for one continuous, full-bleed children’s picture-book illustration. Show a single instant and keep the setting, lighting and palette continuous across the exact centre line. Fill each edge with scenery. Leave the centre clear of faces, hands and important clues. Keep both halves individually readable and safely inside their outside edges.',
    premiumSingleSceneDirection,
    ...(artDirectionVersion
      ? [
          'Give each essential character and story prop complete room on its assigned side. Keep their full silhouettes, faces, hands, and carried objects clear of the middle binding band. Let only continuous scenery cross the fold. Keep the centre free of borders, decorative frames or a painted gutter.',
        ]
      : []),
    ...(generationDesignVersion ? [premiumSimpleSceneDirection] : []),
    silentRight
      ? silentLeft
        ? 'Both pages are silent. Use their full height for the setting and story details.'
        : 'Leave a natural calm area inside the left half for hand lettering. Use the full height of the silent right half for the setting and story details. Keep faces and key action clear of the left half’s lettering area.'
      : silentLeft
        ? 'Leave a natural calm area inside the right half for hand lettering. Use the full height of the silent left half for the setting and story details. Keep faces and key action clear of the right half’s lettering area.'
        : 'Leave a natural calm area inside each half where hand lettering can be painted later. Keep faces and key action clear of those calm areas.',
    'The reference panorama has no writing, simulated fold, panel, border, watermark or gutter.',
    premiumPictureBookArtDirection,
    'Use the character sheet as a likeness and style reference. If a current spread is supplied, preserve its story details and staging except where the scene requests a correction.',
    `Shared visual guide: ${guide}`,
    `Scene: ${action}`,
    ...(leftDescription
      ? [
          `Show the following description within the left-page trim as pictures only: ${JSON.stringify(leftDescription)}`,
        ]
      : []),
    ...(rightDescription
      ? [
          `Show the following description within the right-page trim as pictures only: ${JSON.stringify(rightDescription)}`,
        ]
      : []),
  ].join('\n');
}

export function exactPremiumLettering(actual: string, canonical: string): boolean {
  const collapseLineBreaks = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return collapseLineBreaks(actual) === collapseLineBreaks(canonical);
}
