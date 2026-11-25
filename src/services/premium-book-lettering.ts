import type { z } from 'zod';
import type { premiumAudience } from './premium-book-contract.js';
import { premiumPictureBookArtDirection } from './premium-book-storyboard.js';

export type PremiumLetteredPage = {
  side: 'left' | 'right';
  text: string;
};

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
}: PremiumLetteredPage & {
  action: string;
  guide: string;
  facing?: boolean | undefined;
  feedback?: string | undefined;
  audience?: z.infer<typeof premiumAudience> | undefined;
  locale?: string | undefined;
  hasPrior?: boolean | undefined;
  independent?: { spreadContext: string; hasPrior: boolean; hasNeighbour: boolean } | undefined;
}) {
  return [
    'Paint a finished square, full-bleed page for a children’s picture book. Carry its setting all the way to every canvas edge. Do not paint a book mockup, a page border, a panel, a page number, a gutter or a shadow implying a fold.',
    facing
      ? [
          `Paint only the ${side} half of one continuous illustration. The attached image is the authoritative square crop for that half and includes the bleed. Match its subjects, positions, scale, perspective, light and colours. Keep every subject confined to the part shown in this crop. Any character, prop or place named in the narration only belongs in the illustration if it already appears in this crop.`,
          `Keep a prop or stretch of scenery crossing the ${side === 'left' ? 'right' : 'left'} binding edge cut off at exactly the same place. Carry it beyond the canvas edge. Do not move it inward, complete it or redraw the whole scene on this page.`,
          'Repaint the visible crop at the requested native size with convincing brush detail. Keep essential faces, gestures and clues inside safe trim and clear of the binding.',
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
                'The final attached image is a separately composed neighbouring page. Match its relevant props, characters and medium. Keep the event and staging specific to this page.',
              ]
            : []),
          `Use the following only for story context and any requested correction to this page. Depict only the scene assigned below. Context: ${independent.spreadContext}`,
        ]
      : []),
    ...(hasPrior && !independent
      ? [
          'Use the second image as the current illustration. Preserve all unmentioned staging and details. Render only the pinned narration supplied below.',
        ]
      : []),
    ...(audience === 'children_0-2'
      ? [
          'For ages 0–2, let one large, familiar visual focus and an easy-to-point-at action anchor the page. Give the words simple, open shapes.',
        ]
      : audience === 'children_3-6'
        ? [
            'For ages 3–6, make the character’s action instantly clear and leave a small visual discovery that supports the story.',
          ]
        : []),
    ...(text
      ? [
          letteringStyle,
          'Keep every letter and decorative emphasis mark inside the central 76% of the visible trimmed page, with the bleed outside the trim. Give the binding extra breathing room. Do not put the words in a separate opaque panel, banner, speech bubble or pasted label.',
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
}: {
  action: string;
  guide: string;
  leftDescription?: string | undefined;
  rightDescription?: string | undefined;
  silentLeft?: boolean;
  silentRight?: boolean;
}) {
  return [
    'Paint a reference panorama for one continuous, full-bleed children’s picture-book illustration. Show a single instant and keep the setting, lighting and palette continuous across the exact centre line. Fill each edge with scenery. Leave the centre clear of faces, hands and important clues. Keep both halves individually readable and safely inside their outside edges.',
    premiumSingleSceneDirection,
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
