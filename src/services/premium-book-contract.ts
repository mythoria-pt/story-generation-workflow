import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@/config/locales.js';
import { premiumOpeningColors, premiumOpeningMotifs } from './premium-opening-design.js';
import {
  premiumInvitationHref,
  PREMIUM_INVITATION_PAGE_NUMBER,
} from './premium-book-invitation.js';

export const PREMIUM_BOOK_TYPE = 'premium_children';
export const LEGACY_PREMIUM_PAGE_COUNT = 32;
export const PREMIUM_PAGE_COUNT = PREMIUM_INVITATION_PAGE_NUMBER;
export const PREMIUM_SPREAD_COUNT = 13;
export const PREMIUM_EMBEDDED_LETTERING_EDITION = 'embedded-lettering-v2';
export const PREMIUM_PRINT_PPI = 304;
export const PREMIUM_TEXT_BOX = { x: 0.1, y: 0.09, width: 0.8, height: 0.2 };
export const PREMIUM_FORMAT = {
  trimPoints: 612,
  bleedPoints: 9,
  pageCount: PREMIUM_PAGE_COUNT,
} as const;
export const premiumPageCount = z.union([
  z.literal(LEGACY_PREMIUM_PAGE_COUNT),
  z.literal(PREMIUM_PAGE_COUNT),
]);
export const premiumAudience = z.enum(['children_0-2', 'children_3-6']);

export const premiumAsset = z.object({
  key: z.string().min(1),
  generation: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});
export type PremiumAsset = z.infer<typeof premiumAsset>;

const marker = z.object({ version: z.literal(1), type: z.literal(PREMIUM_BOOK_TYPE) });
const queued = marker.extend({
  state: z.literal('queued'),
  revision: z.uuid(),
  ownerId: z.uuid(),
  audience: premiumAudience,
});
export const premiumMarker = z.discriminatedUnion('state', [
  marker.extend({ state: z.literal('draft') }),
  queued,
  queued.extend({ state: z.literal('published'), manifest: premiumAsset }),
]);

export function hasPremiumMarker(features: unknown): boolean {
  return Boolean(
    features && typeof features === 'object' && Object.hasOwn(features, 'premiumBook'),
  );
}
export type PremiumMarker = z.infer<typeof premiumMarker>;

export class PremiumBookError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function readPremiumMarker(features: unknown): PremiumMarker | undefined {
  if (!hasPremiumMarker(features)) {
    return undefined;
  }
  const parsed = premiumMarker.safeParse((features as { premiumBook: unknown }).premiumBook);
  if (!parsed.success) {
    throw new PremiumBookError(409, 'premium_marker_invalid', 'Invalid premium book marker');
  }
  return parsed.data;
}

export function premiumRevisionPrefix(storyId: string, revision: string): string {
  return `${z.uuid().parse(storyId)}/premium/revisions/${z.uuid().parse(revision)}`;
}

export const openingPlan = z.object({
  title: z.string().min(1),
  author: z.string().min(1),
  locale: z.enum(SUPPORTED_LOCALES),
  dedication: z.string(),
  synopsis: z.string().min(1).max(600),
  createdAt: z.iso.datetime(),
});

const specificationField = z.object({ label: z.string().min(1), value: z.string().min(1) });
const premiumSpecificationPlan = z.object({
  title: specificationField,
  details: z.array(specificationField).length(4),
  copyright: z.string().min(1),
  rights: z.string().min(1),
  promotion: z.string().min(1),
});

export function premiumSpecificationText(specification: z.infer<typeof premiumSpecificationPlan>) {
  return [
    ...[specification.title, ...specification.details].map(
      ({ label, value }) => `${label}: ${value}`,
    ),
    specification.copyright,
    specification.rights,
    specification.promotion,
  ].join('\n');
}

export const narrativeText = z
  .string()
  .min(1)
  .max(110)
  .refine(
    (value) =>
      !/[<>]/u.test(value) &&
      value.trim() === value &&
      [...value].every((character) => character.charCodeAt(0) >= 32),
  )
  .refine((value) => value.split(/\s+/u).every((word) => word.length <= 32));
const panoramaTextLayout = z.enum(['both_pages', 'right_only']);
export const premiumTextLayout = z.enum(['both_pages', 'right_only', 'left_only', 'wordless']);
export const premiumComposition = z.enum([
  'panorama',
  'illustration_facing_text',
  'paired_illustrations',
]);
const renderMode = z.enum(['illustration', 'embedded_art', 'typeset']);
export const PREMIUM_TYPESET_CHARACTER_LIMIT = 420;
export const typesetNarration = z
  .string()
  .min(1)
  .max(PREMIUM_TYPESET_CHARACTER_LIMIT)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[<>]/u.test(value) &&
      [...value].every((c) => c === '\n' || c.charCodeAt(0) >= 32) &&
      value.split('\n\n').length <= 3 &&
      value.split('\n\n').every((p) => p.trim() === p && p.length > 0 && !p.includes('\n')),
  );

export function premiumPageRenderMode(
  composition: z.infer<typeof premiumComposition>,
  placement: PremiumTextLayout,
  side: 'left' | 'right',
): z.infer<typeof renderMode> {
  const narrated = placement === 'both_pages' || placement === `${side}_only`;
  if (!narrated) return 'illustration';
  return composition === 'illustration_facing_text' ? 'typeset' : 'embedded_art';
}
export const premiumOpeningDesign = z.object({
  motif: z.enum(premiumOpeningMotifs),
  background: z.enum(premiumOpeningColors),
});
const premiumMotifBrief = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine(
    (value) =>
      !/[<>]/u.test(value) && [...value].every((character) => character.charCodeAt(0) >= 32),
  );
const premiumMotifSpread = z.number().int().min(1).max(PREMIUM_SPREAD_COUNT);
export type PremiumTextLayout = z.infer<typeof premiumTextLayout>;

export const premiumLeftDescription = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[<>]/u.test(value) && [...value].every((character) => character.charCodeAt(0) >= 32),
  );
const boardSpread = z.object({
  textLayout: panoramaTextLayout,
  leftText: z.union([narrativeText, z.literal('')]),
  rightText: narrativeText,
  action: z.string().min(1).max(900),
  leftDescription: z.union([premiumLeftDescription, z.literal('')]).optional(),
});
function validLeftNarration({ textLayout, leftText }: z.infer<typeof boardSpread>) {
  return textLayout === 'right_only' ? leftText === '' : leftText !== '';
}

const brief = z.string().trim().max(600);
const description = z.union([premiumLeftDescription, z.literal('')]);
const spreadDirection = {
  composition: premiumComposition.describe('The visual composition of this facing pair.'),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe('One editorial sentence about what this choice gives the child.'),
  leftBrief: brief.describe(
    'Independent left illustration brief, or empty for a panorama or typeset left page.',
  ),
  rightBrief: brief.describe(
    'Independent right illustration brief, or empty for a panorama or typeset right page.',
  ),
  rightDescription: description,
};
const mixedBoardSpread = boardSpread.extend({
  ...spreadDirection,
  textLayout: premiumTextLayout,
  leftDescription: description,
  leftText: z.string().max(PREMIUM_TYPESET_CHARACTER_LIMIT),
  rightText: z.string().max(PREMIUM_TYPESET_CHARACTER_LIMIT),
});
function validMixedSpread(spread: z.infer<typeof mixedBoardSpread>) {
  if (spread.composition === 'panorama' && !panoramaTextLayout.safeParse(spread.textLayout).success)
    return false;
  if (
    spread.composition === 'illustration_facing_text' &&
    !['left_only', 'right_only'].includes(spread.textLayout)
  )
    return false;
  for (const side of ['left', 'right'] as const) {
    const mode = premiumPageRenderMode(spread.composition, spread.textLayout, side);
    const text = spread[`${side}Text`];
    if (Boolean(spread[`${side}Description`]) !== (mode === 'illustration')) return false;
    if (
      Boolean(spread[`${side}Brief`]) !== (spread.composition !== 'panorama' && mode !== 'typeset')
    )
      return false;
    if (
      mode === 'illustration'
        ? text !== ''
        : !(mode === 'typeset' ? typesetNarration : narrativeText).safeParse(text).success
    )
      return false;
  }
  return true;
}
const mixedSpread = mixedBoardSpread.refine(
  validMixedSpread,
  'Page roles, briefs and narration must match the composition',
);
// Parse saved boards without introducing defaults into historical checkpoint hashes.
const savedSpread = mixedBoardSpread
  .partial({
    composition: true,
    rationale: true,
    leftBrief: true,
    rightBrief: true,
    leftDescription: true,
    rightDescription: true,
  })
  .refine((spread) =>
    spread.composition
      ? mixedSpread.safeParse(spread).success
      : boardSpread.refine(validLeftNarration).safeParse(spread).success,
  );

export const premiumBoard = z.object({
  openingDesign: premiumOpeningDesign.optional(),
  motifBrief: premiumMotifBrief.optional(),
  motifSpread: premiumMotifSpread.optional(),
  synopsis: openingPlan.shape.synopsis,
  visualGuide: z.string().min(1).max(1600),
  front: z.string().min(1).max(900),
  back: z.string().min(1).max(900),
  opener: z.object({ text: narrativeText, action: z.string().min(1).max(900) }),
  spreads: z.array(savedSpread).length(PREMIUM_SPREAD_COUNT),
  ending: z.object({ text: narrativeText, action: z.string().min(1).max(900) }),
});
// Provider structured output requires every key. An empty description means a narrated left page.
export const historicalGeneratedPremiumBoard = premiumBoard
  .omit({ motifBrief: true, motifSpread: true })
  .extend({
    openingDesign: premiumOpeningDesign,
    spreads: z
      .array(
        boardSpread
          .extend({
            leftDescription: z.union([premiumLeftDescription, z.literal('')]),
          })
          .refine(validLeftNarration)
          .refine(
            (spread) => (spread.textLayout === 'right_only') === (spread.leftDescription !== ''),
          ),
      )
      .length(PREMIUM_SPREAD_COUNT),
  });
export const generatedPremiumBoard = historicalGeneratedPremiumBoard.extend({
  motifBrief: premiumMotifBrief,
  motifSpread: premiumMotifSpread,
});
export const mixedGeneratedPremiumBoard = generatedPremiumBoard.extend({
  spreads: z.array(mixedSpread).length(PREMIUM_SPREAD_COUNT),
});
export type PremiumBoard = z.infer<typeof premiumBoard>;

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export const premiumTextBox = rect.refine(
  (value) =>
    value.x >= 0.08 &&
    value.y >= 0.08 &&
    value.width > 0 &&
    value.height > 0 &&
    value.x + value.width <= 0.92 &&
    value.y + value.height <= 0.92,
);
export type PremiumTextBox = z.infer<typeof premiumTextBox>;
export const premiumPage = z.object({
  number: z.number().int().min(1).max(PREMIUM_PAGE_COUNT),
  kind: z.enum([
    'title',
    'copyright',
    'dedication',
    'synopsis',
    'opener',
    'spread',
    'ending',
    'invitation',
  ]),
  text: z.string(),
  renderMode: renderMode.optional(),
  link: z.object({ label: z.string().trim().min(1).max(100), href: z.url() }).optional(),
  spreadId: z.string().optional(),
  artwork: premiumAsset.optional(),
  reading: premiumAsset.optional(),
  textBox: premiumTextBox.optional(),
  digitalCrop: rect.optional(),
  printCrop: rect.optional(),
});
export type PremiumPage = z.infer<typeof premiumPage>;

const native = z.object({
  nativeWidth: z.number().int().positive(),
  nativeHeight: z.number().int().positive(),
  effectivePpi: z.number().positive(),
});

export function isPremiumNativePrintArtwork(art: z.infer<typeof native>, facing: boolean) {
  const { trimPoints, bleedPoints } = PREMIUM_FORMAT;
  const width = (trimPoints * (facing ? 2 : 1) + 2 * bleedPoints) / 72;
  const height = (trimPoints + 2 * bleedPoints) / 72;
  const effectivePpi = Math.min(art.nativeWidth / width, art.nativeHeight / height);
  return effectivePpi >= PREMIUM_PRINT_PPI && Math.abs(art.effectivePpi - effectivePpi) < 0.01;
}
export const premiumSpread = native.extend({
  composition: premiumComposition.optional(),
  rationale: spreadDirection.rationale.optional(),
  leftBrief: brief.optional(),
  rightBrief: brief.optional(),
  rightDescription: premiumLeftDescription.optional(),
  id: z.string(),
  textLayout: premiumTextLayout.optional(),
  leftDescription: premiumLeftDescription.optional(),
  leftPage: z.number().int(),
  rightPage: z.number().int(),
  master: premiumAsset,
  source: premiumAsset,
  action: z.string(),
});
export type PremiumSpread = z.infer<typeof premiumSpread>;

export const premiumImageConfig = z.object({
  provider: z.literal('openai'),
  model: z.string().min(1),
  quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']),
  spreadSize: z.string().regex(/^\d+x\d+$/),
  squareSize: z.string().regex(/^\d+x\d+$/),
});
export type PremiumImageConfig = z.infer<typeof premiumImageConfig>;

export const premiumManifestBeforePreviews = z
  .object({
    version: z.literal(1),
    type: z.literal(PREMIUM_BOOK_TYPE),
    storyId: z.uuid(),
    ownerId: z.uuid(),
    revision: z.uuid(),
    previousRevision: z.uuid().optional(),
    editionLayout: z.literal(PREMIUM_EMBEDDED_LETTERING_EDITION).optional(),
    spreadLayoutVersion: z.literal(1).optional(),
    audience: premiumAudience.optional(),
    format: z.object({
      trimPoints: z.literal(612),
      bleedPoints: z.literal(9),
      pageCount: premiumPageCount,
    }),
    opening: openingPlan,
    specification: premiumSpecificationPlan.optional(),
    openingDesign: premiumOpeningDesign.optional(),
    motifArtwork: premiumAsset.optional(),
    config: premiumImageConfig,
    textConfig: z.object({
      provider: z.enum(['openai', 'google-genai']),
      model: z.string().min(1),
    }),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    visualGuide: z.string(),
    reference: premiumAsset,
    covers: z.object({ front: premiumAsset, back: premiumAsset }),
    natives: z.record(z.string(), native),
    pages: z.array(premiumPage).min(LEGACY_PREMIUM_PAGE_COUNT).max(PREMIUM_PAGE_COUNT),
    spreads: z.array(premiumSpread).length(PREMIUM_SPREAD_COUNT),
    supersedes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const embeddedLettering = value.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
    if (
      embeddedLettering &&
      (!value.specification ||
        value.specification.title.value !== value.opening.title ||
        value.specification.details[0]?.value !== value.opening.author ||
        premiumSpecificationText(value.specification) !== value.pages[1]?.text)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['specification'],
        message: 'Technical page does not match the frozen publication details',
      });
    }
    if (
      value.motifArtwork &&
      (!value.openingDesign ||
        !value.motifArtwork.key.startsWith(`${value.storyId}/premium/revisions/`) ||
        !value.motifArtwork.key.endsWith(`/assets/${value.motifArtwork.sha256}.png`))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['motifArtwork'],
        message: 'Invalid premium motif artwork',
      });
    }
    if (
      value.pages.length !== value.format.pageCount ||
      (embeddedLettering && value.format.pageCount !== PREMIUM_PAGE_COUNT)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pages'],
        message: 'Interior count does not match premium page plan',
      });
    }
    const kinds = [
      'title',
      'copyright',
      'dedication',
      'synopsis',
      'opener',
      ...Array<string>(PREMIUM_SPREAD_COUNT * 2).fill('spread'),
      'ending',
      'invitation',
    ];
    for (const [index, page] of value.pages.entries()) {
      const kind = kinds[index];
      const invitation = kind === 'invitation';
      const orderMatches = page.number === index + 1 && page.kind === kind;
      if (page.renderMode && (kind !== 'spread' || !value.spreadLayoutVersion)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'renderMode'],
          message: 'Unexpected page rendering role',
        });
      }
      if (invitation) {
        const paragraphs = page.text.split('\n\n');
        if (
          !orderMatches ||
          paragraphs.length !== 2 ||
          paragraphs.some((paragraph) => !paragraph.trim()) ||
          page.link?.href !== premiumInvitationHref(value.opening.locale) ||
          page.artwork ||
          page.textBox ||
          page.spreadId ||
          page.digitalCrop ||
          page.printCrop
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', index],
            message: 'Invalid premium invitation page',
          });
        }
        continue;
      }
      const silent =
        page.renderMode === 'illustration' ||
        (kind === 'spread' &&
          page.number % 2 === 0 &&
          value.spreads[Math.floor((page.number - 6) / 2)]?.textLayout === 'right_only');
      const typeset = page.renderMode === 'typeset';
      const validText =
        (silent
          ? page.text === ''
          : (typeset ? typesetNarration : narrativeText).safeParse(page.text).success) &&
        Boolean(page.textBox) === (!silent && !embeddedLettering);
      if (
        !orderMatches ||
        page.link !== undefined ||
        (page.number >= 5 &&
          (!validText ||
            (typeset
              ? Boolean(page.artwork || page.printCrop || page.digitalCrop)
              : !page.artwork || !page.reading))) ||
        (page.number < 5 &&
          Boolean(
            page.artwork ||
            !page.text.trim() ||
            (embeddedLettering &&
              (page.textBox || page.spreadId || page.digitalCrop || page.printCrop)),
          ))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index],
          message: 'Invalid physical page plan',
        });
      }
    }
    for (const [index, page] of value.pages.entries()) {
      if (
        !page.artwork &&
        page.reading &&
        (!page.reading.key.startsWith(`${value.storyId}/premium/revisions/`) ||
          !page.reading.key.endsWith(`/assets/${page.reading.sha256}.png`))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'reading'],
          message: 'Invalid reading preview',
        });
      }
    }
    for (const [index, spread] of value.spreads.entries()) {
      const left = 6 + index * 2;
      if (value.spreadLayoutVersion) {
        const [leftPage, rightPage] = value.pages.slice(left - 1, left + 1);
        if (
          !embeddedLettering ||
          !value.audience ||
          !spread.composition ||
          !spread.textLayout ||
          !mixedSpread.safeParse({
            ...spread,
            leftDescription: spread.leftDescription ?? '',
            rightDescription: spread.rightDescription ?? '',
            leftText: leftPage?.text,
            rightText: rightPage?.text,
          }).success ||
          leftPage?.renderMode !==
            premiumPageRenderMode(spread.composition, spread.textLayout, 'left') ||
          rightPage?.renderMode !==
            premiumPageRenderMode(spread.composition, spread.textLayout, 'right')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['spreads', index],
            message: 'Invalid mixed spread page plan',
          });
        }
      } else if (
        spread.composition ||
        (spread.textLayout && !panoramaTextLayout.safeParse(spread.textLayout).success)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['spreads', index],
          message: 'Mixed layouts require a versioned page plan',
        });
      }
      if (
        spread.id !== `spread-${index + 1}` ||
        spread.leftPage !== left ||
        spread.rightPage !== left + 1 ||
        value.pages[left - 1]?.spreadId !== spread.id ||
        value.pages[left]?.spreadId !== spread.id ||
        (embeddedLettering &&
          (!isPremiumNativePrintArtwork(spread, true) ||
            spread.nativeWidth !== value.natives[spread.id]?.nativeWidth ||
            spread.nativeHeight !== value.natives[spread.id]?.nativeHeight ||
            spread.effectivePpi !== value.natives[spread.id]?.effectivePpi))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['spreads', index],
          message: 'Invalid facing spread',
        });
      }
    }
    if (embeddedLettering) {
      for (const phase of [
        'front',
        'back',
        'opener',
        'ending',
        ...value.spreads.map(({ id }) => id),
      ]) {
        const info = value.natives[phase];
        if (!info || !isPremiumNativePrintArtwork(info, phase.startsWith('spread-'))) {
          ctx.addIssue({
            code: 'custom',
            path: ['natives', phase],
            message: 'Invalid native print artwork resolution',
          });
        }
      }
    }
  });
export const premiumManifest = premiumManifestBeforePreviews.superRefine((book, ctx) => {
  if (book.spreadLayoutVersion) {
    for (const [index, page] of book.pages.entries()) {
      if (!page.reading)
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'reading'],
          message: 'Published page is missing its reading image',
        });
    }
  }
});
export type PremiumManifest = z.infer<typeof premiumManifest>;

export function applyPremiumSpreadText(
  spread: PremiumSpread,
  left: PremiumPage,
  right: PremiumPage,
  edit: {
    textLayout?: PremiumTextLayout | undefined;
    leftText?: string | undefined;
    rightText?: string | undefined;
    leftDescription?: string | undefined;
    artworkInstructions?: string | undefined;
  },
  embeddedLettering = false,
): PremiumTextLayout {
  const previous = spread.textLayout ?? 'both_pages';
  const layout = edit.textLayout ?? previous;
  if (
    (layout === 'right_only' && edit.leftText !== undefined && edit.leftText !== '') ||
    (layout === 'both_pages' && (edit.leftText === '' || edit.leftDescription !== undefined)) ||
    (previous === 'both_pages' &&
      layout === 'right_only' &&
      (edit.leftText !== '' || !edit.rightText)) ||
    (previous === 'right_only' && layout === 'both_pages' && !edit.leftText)
  ) {
    throw new PremiumBookError(
      409,
      'premium_correction_layout',
      'Changing this text layout requires explicit new story lines',
    );
  }
  if (edit.leftText !== undefined) left.text = edit.leftText;
  if (edit.rightText) right.text = edit.rightText;
  spread.textLayout = layout;
  if (layout === 'right_only') {
    delete left.textBox;
    if (edit.leftDescription) spread.leftDescription = edit.leftDescription;
    else if (edit.artworkInstructions || previous !== layout) delete spread.leftDescription;
  } else {
    if (!embeddedLettering) left.textBox ??= PREMIUM_TEXT_BOX;
    delete spread.leftDescription;
  }
  return layout;
}
