import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@/config/locales.js';
import { premiumOpeningColors, premiumOpeningMotifs } from './premium-opening-design.js';

export const PREMIUM_BOOK_TYPE = 'premium_children';
export const PREMIUM_PAGE_COUNT = 32;
export const PREMIUM_SPREAD_COUNT = 13;
export const PREMIUM_TEXT_BOX = { x: 0.1, y: 0.09, width: 0.8, height: 0.2 };
export const PREMIUM_FORMAT = { trimPoints: 612, bleedPoints: 9, pageCount: 32 } as const;
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
export const premiumTextLayout = z.enum(['both_pages', 'right_only']);
export const premiumOpeningDesign = z.object({
  motif: z.enum(premiumOpeningMotifs),
  background: z.enum(premiumOpeningColors),
});
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
  textLayout: premiumTextLayout,
  leftText: z.union([narrativeText, z.literal('')]),
  rightText: narrativeText,
  action: z.string().min(1).max(900),
  leftDescription: z.union([premiumLeftDescription, z.literal('')]).optional(),
});
function validLeftNarration({ textLayout, leftText }: z.infer<typeof boardSpread>) {
  return textLayout === 'right_only' ? leftText === '' : leftText !== '';
}

export const premiumBoard = z.object({
  openingDesign: premiumOpeningDesign.optional(),
  synopsis: openingPlan.shape.synopsis,
  visualGuide: z.string().min(1).max(1600),
  front: z.string().min(1).max(900),
  back: z.string().min(1).max(900),
  opener: z.object({ text: narrativeText, action: z.string().min(1).max(900) }),
  spreads: z.array(boardSpread.refine(validLeftNarration)).length(PREMIUM_SPREAD_COUNT),
  ending: z.object({ text: narrativeText, action: z.string().min(1).max(900) }),
});
// Provider structured output requires every key. An empty description means a narrated left page.
export const generatedPremiumBoard = premiumBoard.extend({
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
export type PremiumBoard = z.infer<typeof premiumBoard>;

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const textBox = rect.refine(
  (value) =>
    value.x >= 0.08 &&
    value.y >= 0.08 &&
    value.width > 0 &&
    value.height > 0 &&
    value.x + value.width <= 0.92 &&
    value.y + value.height <= 0.92,
);
export const premiumPage = z.object({
  number: z.number().int().min(1).max(32),
  kind: z.enum(['title', 'copyright', 'dedication', 'synopsis', 'opener', 'spread', 'ending']),
  text: z.string(),
  spreadId: z.string().optional(),
  artwork: premiumAsset.optional(),
  reading: premiumAsset.optional(),
  textBox: textBox.optional(),
  digitalCrop: rect.optional(),
  printCrop: rect.optional(),
});
export type PremiumPage = z.infer<typeof premiumPage>;

const native = z.object({
  nativeWidth: z.number().int().positive(),
  nativeHeight: z.number().int().positive(),
  effectivePpi: z.number().positive(),
});
export const premiumSpread = native.extend({
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

export const premiumManifest = z
  .object({
    version: z.literal(1),
    type: z.literal(PREMIUM_BOOK_TYPE),
    storyId: z.uuid(),
    ownerId: z.uuid(),
    revision: z.uuid(),
    previousRevision: z.uuid().optional(),
    format: z.object({
      trimPoints: z.literal(612),
      bleedPoints: z.literal(9),
      pageCount: z.literal(32),
    }),
    opening: openingPlan,
    openingDesign: premiumOpeningDesign.optional(),
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
    pages: z.array(premiumPage).length(PREMIUM_PAGE_COUNT),
    spreads: z.array(premiumSpread).length(PREMIUM_SPREAD_COUNT),
    supersedes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const kinds = ['title', 'copyright', 'dedication', 'synopsis', 'opener'];
    for (const [index, page] of value.pages.entries()) {
      const kind = kinds[index] ?? (index === PREMIUM_PAGE_COUNT - 1 ? 'ending' : 'spread');
      const silent =
        kind === 'spread' &&
        page.number % 2 === 0 &&
        value.spreads[Math.floor((page.number - 6) / 2)]?.textLayout === 'right_only';
      const validText = silent
        ? page.text === '' && !page.textBox
        : Boolean(page.textBox && narrativeText.safeParse(page.text).success);
      if (
        page.number !== index + 1 ||
        page.kind !== kind ||
        (page.number >= 5 && (!page.artwork || !page.reading || !validText)) ||
        (page.number < 5 && Boolean(page.artwork || !page.text.trim()))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index],
          message: 'Invalid physical page plan',
        });
      }
    }
    for (const [index, spread] of value.spreads.entries()) {
      const left = 6 + index * 2;
      if (
        spread.id !== `spread-${index + 1}` ||
        spread.leftPage !== left ||
        spread.rightPage !== left + 1 ||
        value.pages[left - 1]?.spreadId !== spread.id ||
        value.pages[left]?.spreadId !== spread.id
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['spreads', index],
          message: 'Invalid facing spread',
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
    left.textBox = PREMIUM_TEXT_BOX;
    delete spread.leftDescription;
  }
  return layout;
}
