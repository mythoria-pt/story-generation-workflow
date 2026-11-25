import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import type { TextGenerationUsage } from '@/ai/interfaces.js';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import { TokenUsageTrackingService, type TokenUsageRequest } from './token-usage-tracking.js';
import { PremiumBookError, type PremiumImageConfig } from './premium-book-contract.js';
import type { PremiumSpreadReviewAreas } from './premium-book-artwork.js';
import {
  exactPremiumLettering,
  premiumSingleSceneDirection,
  type PremiumLetteredPage,
} from './premium-book-lettering.js';

const qualityReview = z.object({
  noLettering: z.boolean(),
  coherentArtwork: z.boolean(),
  consistentCharacters: z.boolean(),
});

const spreadCompositionReview = qualityReview.extend({
  clearTextArea: z.boolean(),
  safeGutter: z.boolean(),
  safeTrim: z.boolean(),
});
const singleImageReview = qualityReview.extend({ safeComposition: z.boolean() });

export const premiumReviewCheck = z.enum([
  'noLettering',
  'coherentArtwork',
  'centreLine',
  'consistentCharacters',
  'clearTextArea',
  'safeGutter',
  'safeTrim',
  'safeComposition',
  'leftDescriptionAccurate',
  'rightDescriptionAccurate',
  'pageDescriptionAccurate',
  'pairedContinuity',
  'exactLettering',
  'readableLettering',
  'safeLettering',
  'childlikeLettering',
  'childlikeArtwork',
]);
type ReviewCheck = z.infer<typeof premiumReviewCheck>;
type PageSide = PremiumLetteredPage['side'];

export function isPremiumLetteringCheck(check: ReviewCheck): boolean {
  return ['exactLettering', 'readableLettering', 'safeLettering', 'childlikeLettering'].includes(
    check,
  );
}

const reviewGuidance: Record<ReviewCheck, string> = {
  noLettering: 'Remove letters, numerals, logos, labels and watermarks from the artwork.',
  coherentArtwork: `Use the layout described for this illustration and avoid simulated joins. ${premiumSingleSceneDirection}`,
  centreLine:
    'Carry continuous scenery and even lighting across the middle. Angle physical frames and move their hard vertical edges away from the exact centre. Keep the important parts of the frame or prop visible on the required side. Avoid a sudden change in color or contrast between halves.',
  consistentCharacters:
    'Match the visible recurring characters with established appearances to their likeness references.',
  clearTextArea: 'Move faces, actions and essential objects clear of the text areas.',
  safeGutter: 'Move faces, hands and essential objects out of the central binding area.',
  safeTrim: 'Move faces, hands and essential objects away from the outer trim edges.',
  safeComposition: 'Follow the placement rules for this illustration.',
  leftDescriptionAccurate: 'Show all essential details of the left-page description on that page.',
  rightDescriptionAccurate:
    'Show all essential details of the right-page description on that page.',
  pageDescriptionAccurate: 'Show the important action and details assigned to this page.',
  pairedContinuity:
    'Match the established characters, prop details, lighting and artistic medium across the pair while keeping the assigned scenes distinct.',
  exactLettering:
    'Paint only the complete pinned narration on its assigned page, letter for letter.',
  readableLettering: 'Give each word readable size, contrast, line spacing and clear letterforms.',
  safeLettering:
    'Move all lettering into the inner 76% of the trimmed page. Allow at least 12% of the trimmed width or height from each edge to every letter, accent and flourish. Start the first line at least 12% down from the top trim, leaving an empty band of background above it and lowering the main characters to make room. Keep decorative accents out of the margins and reflow into fewer lines if needed to keep this inset and a comfortable reading size.',
  childlikeLettering:
    'Use warm, clear hand-painted letterforms in the same medium as the illustration.',
  childlikeArtwork:
    'Use warm picture-book staging with a clear action, expressive characters and an inviting setting.',
};

export function premiumReviewGuidance(checks: readonly ReviewCheck[], independent = false) {
  return checks
    .map((check) =>
      independent && check === 'coherentArtwork'
        ? 'Show one coherent moment on this standalone page. Use one continuous setting without panels, insets, borders or simulated folds.'
        : reviewGuidance[check],
    )
    .join(' ');
}

export class PremiumArtworkReviewError extends PremiumBookError {
  constructor(
    readonly failedChecks: readonly ReviewCheck[],
    readonly failedLetteringSides: readonly PageSide[] = [],
    readonly failedLetteringChecksBySide: Partial<Record<PageSide, readonly ReviewCheck[]>> = {},
  ) {
    super(
      502,
      'premium_artwork_review',
      `Premium illustration failed review. ${premiumReviewGuidance(failedChecks)}`,
    );
  }
}

export class PremiumGuideReviewError extends PremiumArtworkReviewError {
  constructor(
    failedChecks: readonly ReviewCheck[],
    readonly replacementScene: string,
  ) {
    super(failedChecks);
  }
}

export async function reviewPremiumSpreadTextPlacement(
  review: (position: 'top' | 'bottom') => Promise<void>,
  preferred: 'top' | 'bottom' = 'top',
): Promise<'top' | 'bottom'> {
  try {
    await review(preferred);
    return preferred;
  } catch (error) {
    if (
      preferred === 'bottom' ||
      !(error instanceof PremiumArtworkReviewError) ||
      error.failedChecks.length !== 1 ||
      error.failedChecks[0] !== 'clearTextArea'
    ) {
      throw error;
    }
  }
  await review('bottom');
  return 'bottom';
}

export const premiumTextConfig = z.object({
  provider: z.enum(['openai', 'google-genai']),
  model: z.string().min(1),
});
export type PremiumTextConfig = z.infer<typeof premiumTextConfig>;
type Scope = { storyId: string; ownerId: string; revision: string };

// A spread stage can plan once, generate once and review two placements within
// the Workflows 540-second request timeout. Leave time for storage and export.
const spreadShotPlanTimeoutMs = 45_000;
const spreadImageTimeoutMs = 210_000;
const spreadReviewTimeoutMs = 75_000;
// A guide, guide review, parallel page renders and final review use up to 495
// seconds of provider request time within the 540-second Workflows stage.
const letteredImageTimeoutMs = 195_000;
const letteredGuideReviewTimeoutMs = 30_000;

export function getPremiumConfiguration() {
  const env = getEnvironment();
  return {
    image: {
      provider: env.PREMIUM_IMAGE_PROVIDER,
      model: env.PREMIUM_IMAGE_MODEL,
      quality: env.PREMIUM_IMAGE_QUALITY,
      spreadSize: env.PREMIUM_IMAGE_SPREAD_SIZE,
      squareSize: env.PREMIUM_IMAGE_SQUARE_SIZE,
    },
    text: {
      provider: env.TEXT_PROVIDER,
      model:
        env.TEXT_PROVIDER === 'openai'
          ? (process.env.OPENAI_BASE_MODEL ??
            env.OPENAI_TEXT_MODEL ??
            env.OPENAI_MODEL ??
            env.OPENAI_BASE_MODEL)
          : env.GOOGLE_GENAI_MODEL,
    },
  };
}

function openAI(timeout = 240_000) {
  const key = getEnvironment().OPENAI_API_KEY;
  if (!key) {
    throw new PremiumBookError(
      503,
      'premium_openai_unconfigured',
      'Premium OpenAI credential unavailable',
    );
  }
  return new OpenAI({ apiKey: key, timeout, maxRetries: 0 });
}

function parseOutput<T>(schema: z.ZodType<T>, value: string): T {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new PremiumBookError(
      502,
      'premium_ai_output',
      'Premium provider returned invalid structured output',
    );
  }
}

export async function generatePremiumText<T>(
  scope: Scope,
  config: PremiumTextConfig,
  phase: string,
  prompt: string,
  schema: z.ZodType<T>,
  images: Buffer[] = [],
  reportUsage: (usage: TokenUsageRequest) => Promise<void> = (usage) =>
    new TokenUsageTrackingService().recordUsage(usage),
): Promise<T> {
  const env = getEnvironment();
  const usage: TextGenerationUsage = {};
  const shotPlanning = phase.startsWith('shot-plan-');
  const mixedStoryboard = phase === 'storyboard-mixed-layout';
  const guideReview = phase.endsWith('-lettering-guide-review') && images.length > 0;
  const spreadReview =
    (phase.startsWith('spread-') || phase.endsWith('-lettering-review')) && images.length > 0;
  const timeout = guideReview
    ? letteredGuideReviewTimeoutMs
    : shotPlanning
      ? spreadShotPlanTimeoutMs
      : spreadReview
        ? spreadReviewTimeoutMs
        : undefined;
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' });
  let result: string;
  try {
    if (config.provider === 'openai') {
      const response = await openAI(timeout).responses.create({
        model: config.model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              ...images.map((image) => ({
                type: 'input_image' as const,
                image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
                detail: 'high' as const,
              })),
            ],
          },
        ],
        text: {
          format: { type: 'json_schema', name: 'premium_book', strict: true, schema: jsonSchema },
        },
        max_output_tokens: mixedStoryboard
          ? 16_384
          : shotPlanning
            ? 1024
            : guideReview
              ? 1536
              : images.length
                ? 4096
                : 8192,
        store: false,
      });
      result = response.output_text;
      usage.model = response.model;
      usage.inputTokens = response.usage?.input_tokens;
      usage.outputTokens = response.usage?.output_tokens;
      usage.cachedInputTokens = response.usage?.input_tokens_details.cached_tokens;
      if (
        response.incomplete_details?.reason === 'content_filter' ||
        response.output.some(
          (item) =>
            item.type === 'message' && item.content.some((content) => content.type === 'refusal'),
        )
      ) {
        throw new PremiumBookError(
          422,
          'premium_text_blocked',
          'Premium story content blocked by provider',
        );
      }
    } else {
      const text = new GoogleGenAITextService({
        apiKey: env.GOOGLE_GENAI_API_KEY ?? '',
        model: config.model,
      });
      result = await text.complete(prompt, {
        model: config.model,
        privateContent: true,
        signal: AbortSignal.timeout(timeout ?? 200_000),
        maxTokens: mixedStoryboard ? 16_384 : guideReview ? 2048 : shotPlanning ? 4096 : 8192,
        thinkingLevel: 'low',
        jsonSchema,
        mediaParts: images.map((image) => ({ mimeType: 'image/jpeg', data: image })),
        usageObserver: (measured) => Object.assign(usage, measured),
      });
    }
  } catch (error) {
    if (shotPlanning && (error as { code?: string } | null)?.code === 'INCOMPLETE_OUTPUT') {
      throw new PremiumBookError(
        502,
        'premium_shot_plan_incomplete',
        'Premium shot planner returned incomplete output',
      );
    }
    throw error;
  } finally {
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      await reportUsage({
        authorId: scope.ownerId,
        storyId: scope.storyId,
        action: shotPlanning
          ? 'prompt_rewrite'
          : phase === 'storyboard' || mixedStoryboard || phase === 'storyboard-typeset-fit'
            ? 'story_outline'
            : 'image_analysis',
        aiModel: usage.model ?? config.model,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined && {
          cachedInputTokens: usage.cachedInputTokens,
        }),
        inputPromptJson: { mode: 'premium', revision: scope.revision, phase },
      });
    }
  }
  return parseOutput(schema, result);
}

const letteredGuideReview = z
  .object({
    coherentArtwork: z.boolean(),
    safeGutter: z.boolean(),
    replacementScene: z.string().trim().max(900),
  })
  .refine(
    ({ coherentArtwork, safeGutter, replacementScene }) =>
      (coherentArtwork && safeGutter) || replacementScene.length >= 20,
  );

export async function reviewPremiumLetteredGuide(
  scope: Scope,
  config: PremiumTextConfig,
  phase: string,
  guide: Buffer,
  reference: Buffer,
  reportUsage?: (usage: TokenUsageRequest) => Promise<void>,
  scene?: {
    action: string;
    leftDescription?: string | undefined;
    rightDescription?: string | undefined;
    previousReplacement?: string | undefined;
  },
) {
  const images = await Promise.all([reviewJpeg(guide), reviewJpeg(reference)]);
  const { replacementScene, ...checks } = await generatePremiumText(
    scope,
    config,
    `${phase}-lettering-guide-review`,
    [
      'Independently inspect the first image as a whole full-bleed picture-book panorama. Use the second image only to recognise recurring characters.',
      'Approve coherentArtwork if the two halves are one continuous illustration of one drawable instant in one coherent setting. Reject artificial joins, panels and repeated physical depictions of a recurring character or of a distinctive story prop. An unmistakable natural reflection belonging to its visible subject in the same setting is allowed.',
      'Approve safeGutter if the middle band from 45% to 55% of the panorama is clear of faces, key hand gestures and other essential visual details. Continuous scenery and incidental edges can cross the band.',
      'For an approved image return an empty replacementScene. If either check fails, write a concrete alternative for the illustrator in replacementScene, between 20 and 900 characters. Describe one drawable instant, a coherent setting, the position and scale of the visible subjects and how the surroundings connect across the middle. Show each physical character once. Use gestures, props, reflections or aftermath to carry other beats. Keep each essential page clue visible on its assigned side if supplied. Replace the failed staging with a specific new arrangement that preserves the visual story facts. Return only the visual description without narration, dialogue, outlines or production instructions.',
      ...(scene ? [`Frozen visual scene: ${JSON.stringify(scene.action)}`] : []),
      ...(scene?.leftDescription
        ? [
            `Required visual clue for the silent left trim: ${JSON.stringify(scene.leftDescription)}`,
          ]
        : []),
      ...(scene?.rightDescription
        ? [
            `Required visual clue for the silent right trim: ${JSON.stringify(scene.rightDescription)}`,
          ]
        : []),
      ...(scene?.previousReplacement
        ? [
            `This guide attempted the following replacement. Use a different arrangement if it still fails: ${JSON.stringify(scene.previousReplacement)}`,
          ]
        : []),
    ].join('\n'),
    letteredGuideReview,
    images.map(({ data }) => data),
    reportUsage,
  );
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check as ReviewCheck);
  if (failedChecks.length) {
    if ([scene?.action.trim(), scene?.previousReplacement?.trim()].includes(replacementScene)) {
      throw new PremiumBookError(
        502,
        'premium_ai_output',
        'Premium guide review did not propose a new composition',
      );
    }
    logger.warn('Premium panorama guide failed review', {
      phase,
      revision: scope.revision,
      failedChecks,
    });
    throw new PremiumGuideReviewError(failedChecks, replacementScene);
  }
}

const letteringLocation = z.enum(['none', 'left', 'right', 'both', 'unknown']);
const letteredReview = z.object({
  leftTranscription: z.string(),
  rightTranscription: z.string(),
  typography: z.object({
    readableLettering: letteringLocation,
    safeLettering: letteringLocation,
    childlikeLettering: letteringLocation,
  }),
  coherentArtwork: z.boolean(),
  consistentCharacters: z.boolean(),
  childlikeArtwork: z.boolean(),
  safeGutter: z.boolean(),
  safeTrim: z.boolean(),
});

const pictureBookArtCheck =
  'Approve childlikeArtwork when the image visibly reads as a crafted illustration for young children, with a clear visual focus and expressive, readable characters or shapes. Illustrated realism can pass when the image has visibly authored illustrative choices. Reject a photographic or live-action look, even with warm light or a friendly subject. A quiet, sad or suspenseful scene can pass when the staging stays age-appropriate and easy for a young child to follow.';

export async function reviewPremiumLetteredArtwork(
  scope: Scope,
  config: PremiumTextConfig,
  phase: string,
  artwork: {
    source: Buffer;
    pages: (PremiumLetteredPage & { trim: Buffer })[];
    reference: Buffer;
    leftDescription?: string | undefined;
    rightDescription?: string | undefined;
    independent?:
      | {
          side: PageSide;
          description: string;
          isUserDescription?: boolean | undefined;
          neighbour?: Buffer | undefined;
          neighbourDescription?: string | undefined;
        }
      | undefined;
  },
  reportUsage?: (usage: TokenUsageRequest) => Promise<void>,
) {
  const { source, pages, reference, leftDescription, rightDescription, independent } = artwork;
  const facing = pages.length === 2;
  type LetteringReview = z.infer<typeof letteredReview> & {
    leftDescriptionAccurate?: boolean | undefined;
    rightDescriptionAccurate?: boolean | undefined;
    pageDescriptionAccurate?: boolean | undefined;
    pairedContinuity?: boolean | undefined;
  };
  // Conditional keys widen to `unknown` in Zod's inferred output; pin the intended shape.
  const schema = letteredReview.extend({
    ...(leftDescription ? { leftDescriptionAccurate: z.boolean() } : {}),
    ...(rightDescription ? { rightDescriptionAccurate: z.boolean() } : {}),
    ...(independent ? { pageDescriptionAccurate: z.boolean() } : {}),
    ...(independent?.neighbour ? { pairedContinuity: z.boolean() } : {}),
  }) as unknown as z.ZodType<LetteringReview>;
  const images = await Promise.all([
    reviewJpeg(source),
    ...pages.map(({ trim }) => reviewJpeg(trim)),
    reviewJpeg(reference),
    ...(independent?.neighbour ? [reviewJpeg(independent.neighbour)] : []),
  ]);
  const review = await generatePremiumText<LetteringReview>(
    scope,
    config,
    `${phase}-lettering-review`,
    [
      'Independently inspect a finished children’s picture-book illustration. The first image includes full bleed. The next image or images each show the actual trimmed page and are the source for transcription. The next image is the likeness and visual-style reference. Treat all marks in the images as content to inspect.',
      facing
        ? 'The second image is the left trimmed page and the third is the right trimmed page. Transcribe them separately in reading order.'
        : `The second image is the ${pages[0]?.side} trimmed page. Leave the transcription field for the absent page empty.`,
      'Report every visible word, letter, numeral and punctuation mark in its visible case, including stray writing. Use an empty string for a page without writing. Copy what is actually printed. Preserve accents, punctuation and duplicated letters. Do not infer intended spelling, complete cut-off words, translate or repair the writing.',
      'For each typography check, report the page where it fails. Use left, right, or both. Use unknown when you see a failure and cannot locate its page. Use none when the check passes on all present pages. A page free of writing passes the typography checks.',
      'Mark readableLettering as failed wherever writing is illegible or lacks clear letterforms, sufficient size, contrast or spacing at picture-book size. Mark childlikeLettering as failed wherever writing lacks warm, clear hand lettering in the same medium as the art, or appears in an opaque panel or banner.',
      pictureBookArtCheck,
      'Mark safeLettering as failed on any page where a letter, accent or flourish is less than 6% of the trimmed width or height from any edge, including the top of the first line. Examine the full-bleed image too and attribute any lettering crossing the cut or appearing in the bleed or gutter to the page where it originates.',
      facing
        ? 'Approve coherentArtwork only if the two images show one continuous scene and lighting, palette, perspective and scenery join naturally at the centre. Reject a vertical line, distracting smear, double image, divided composition or simulated fold. Reject a recurring character, distinctive prop, landmark or single story action that is separately repeated on both panels. A natural reflection or a single object visibly continuing across the join is allowed. Approve safeGutter only if the centre band from 45% to 55% of the full spread stays clear of faces, hands and other essential illustration details. Mark lettering in the gutter under safeLettering.'
        : 'Approve coherentArtwork only if the image depicts one continuous scene, without an inset, border, fold or mockup. Check safeGutter for essential illustrated details at the binding edge of the trimmed page. Mark lettering in the gutter under safeLettering.',
      'Approve safeTrim if every face, important gesture and story clue remains recognizable and safely within trim. Approve consistentCharacters if the depicted recurring characters match the reference or if no recurring character is shown.',
      ...(leftDescription
        ? [
            `Approve leftDescriptionAccurate only if the isolated left trim visibly supports this description: ${JSON.stringify(leftDescription)}.`,
          ]
        : []),
      ...(rightDescription
        ? [
            `Approve rightDescriptionAccurate only if the isolated right trim visibly supports this description: ${JSON.stringify(rightDescription)}.`,
          ]
        : []),
      ...(independent
        ? [
            independent.isUserDescription
              ? `Approve pageDescriptionAccurate only if the ${independent.side} trim visibly supports this accessibility description and its essential visual details: ${JSON.stringify(independent.description)}.`
              : `Approve pageDescriptionAccurate if the ${independent.side} trim depicts the main assigned story beat, setting and characters for this page rather than the facing page’s beat: ${JSON.stringify(independent.description)}. Allow reasonable illustrative interpretation of minor props, poses, background layout or staging cues.`,
            ...(independent.neighbour
              ? [
                  `The final image is the facing page and shows its own related scene${independent.neighbourDescription ? `: ${JSON.stringify(independent.neighbourDescription)}` : '.'} Use it only to evaluate pairedContinuity. Approve pairedContinuity if the two scenes have a consistent medium, recurring characters and shared props and each composition supports its distinct story beat. The two images can have different staging, lighting or perspective when their scenes call for it. Do not transcribe or report typography on the facing illustration.`,
                ]
              : []),
          ]
        : []),
    ].join('\n'),
    schema,
    images.map(({ data }) => data),
    reportUsage,
  );
  const { leftTranscription, rightTranscription, typography, ...checks } = review;
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check as ReviewCheck);
  const canonical = (side: PremiumLetteredPage['side']) =>
    pages.find((page) => page.side === side)?.text ?? '';
  const transcriptions = { left: leftTranscription, right: rightTranscription };
  const transcriptFailures = (['left', 'right'] as const).filter(
    (side) => !exactPremiumLettering(transcriptions[side], canonical(side)),
  );
  const presentSides = pages.map(({ side }) => side);
  const failedLetteringChecksBySide: Record<PageSide, ReviewCheck[]> = { left: [], right: [] };
  function recordTypographyFailure(check: ReviewCheck, sides: readonly PageSide[]) {
    failedChecks.push(check);
    for (const side of sides) failedLetteringChecksBySide[side].push(check);
  }
  for (const [check, location] of Object.entries(typography)) {
    if (location === 'none') continue;
    if ((location === 'left' || location === 'right') && !presentSides.includes(location)) {
      continue;
    }
    const sides = location === 'left' || location === 'right' ? [location] : presentSides;
    recordTypographyFailure(check as ReviewCheck, sides);
  }
  if (transcriptFailures.length) {
    const knownSides = transcriptFailures.filter((side) => presentSides.includes(side));
    recordTypographyFailure('exactLettering', knownSides.length ? knownSides : presentSides);
  }
  if (failedChecks.length) {
    const failedLetteringSides = presentSides.filter(
      (side) => failedLetteringChecksBySide[side].length,
    );
    logger.warn('Premium visual review rejected artwork', {
      phase,
      revision: scope.revision,
      failedChecks,
    });
    throw new PremiumArtworkReviewError(
      failedChecks,
      failedLetteringSides,
      failedLetteringChecksBySide,
    );
  }
}

const safePictureBookFramings = [
  'Keep this strictly gentle, wholesome, non-threatening children’s picture-book artwork in an original hand-painted illustrated style: warm friendly mood, zero danger, zero realistic photographic likeness, and strictly original non-trademarked illustration.',
  'Strictly gentle, wholesome original children’s book illustration. Render only soft, peaceful painterly artwork and legible hand lettering faithfully matching the attached reference image; depict no scary, dangerous, photorealistic, or trademarked character designs.',
];

function isModerationBlock(error: unknown): error is InstanceType<typeof OpenAI.APIError> {
  return (
    error instanceof OpenAI.APIError &&
    ['moderation_blocked', 'content_policy_violation'].includes(error.code ?? '')
  );
}

export async function generatePremiumImage(
  scope: Scope,
  config: PremiumImageConfig,
  phase: string,
  prompt: string,
  size: string,
  references: Buffer[],
  reportUsage: (usage: TokenUsageRequest) => Promise<void> = (usage) =>
    new TokenUsageTrackingService().recordUsage(usage),
) {
  const motif = phase === 'opening_motif';
  const lettered = /-lettering-(?:guide|left|right)$/u.test(phase);
  const client = openAI(
    motif
      ? 90_000
      : lettered
        ? letteredImageTimeoutMs
        : phase.startsWith('spread-')
          ? spreadImageTimeoutMs
          : undefined,
  );
  const baseParams = {
    model: config.model,
    quality: config.quality,
    size,
    n: 1,
    output_format: 'png' as const,
    background: motif ? ('transparent' as const) : ('opaque' as const),
  };
  const requestImage = async (effectivePrompt: string) =>
    references.length
      ? client.images.edit({
          ...baseParams,
          prompt: effectivePrompt,
          image: await Promise.all(
            references.map((image, index) =>
              toFile(image, `reference-${index}.jpg`, { type: 'image/jpeg' }),
            ),
          ),
        })
      : client.images.generate({ ...baseParams, prompt: effectivePrompt });
  let output;
  const started = Date.now();
  try {
    const prompts = [prompt, ...safePictureBookFramings.map((framing) => `${prompt}\n${framing}`)];
    for (const [attempt, effectivePrompt] of prompts.entries()) {
      try {
        output = await requestImage(effectivePrompt);
        break;
      } catch (error) {
        if (!isModerationBlock(error) || attempt === prompts.length - 1) {
          throw error;
        }
        logger.warn('Premium image blocked by provider; retrying with safe framing', {
          phase,
          revision: scope.revision,
          providerCode: error.code,
          retry: attempt + 1,
        });
      }
    }
  } catch (error) {
    if (isModerationBlock(error)) {
      logger.warn('Premium image blocked by provider after safe-framing retries', {
        phase,
        revision: scope.revision,
        providerCode: error.code,
      });
      throw new PremiumBookError(
        422,
        'premium_image_blocked',
        'Premium artwork blocked by provider',
      );
    }
    if (error instanceof OpenAI.APIError && [400, 401, 403, 404].includes(error.status ?? 0)) {
      throw new PremiumBookError(
        400,
        'premium_provider_rejected',
        'Premium image model or request rejected',
      );
    }
    throw new PremiumBookError(
      502,
      'premium_provider_failed',
      'Premium image provider unavailable',
    );
  }
  const encoded = output?.data?.[0]?.b64_json;
  if (!encoded) {
    throw new PremiumBookError(
      502,
      'premium_image_missing',
      'Premium image provider returned no art',
    );
  }
  const usage = output?.usage;
  await reportUsage({
    authorId: scope.ownerId,
    storyId: scope.storyId,
    action: phase === 'references' ? 'character_generation' : 'image_generation',
    aiModel: config.model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    imageInputTokens: usage?.input_tokens_details?.image_tokens ?? 0,
    imageOutputTokens: usage?.output_tokens_details?.image_tokens ?? usage?.output_tokens ?? 0,
    ...(config.quality !== 'xhigh' && config.quality !== 'max' && { imageQuality: config.quality }),
    imageSize: size,
    inputPromptJson: {
      mode: 'premium',
      revision: scope.revision,
      phase,
      quality: config.quality,
      durationMs: Date.now() - started,
    },
  });
  return Buffer.from(encoded, 'base64');
}

function reviewJpeg(image: Buffer) {
  return sharp(image)
    .resize({ width: 1300, height: 800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
}

async function markSpreadReviewAreas(
  image: Awaited<ReturnType<typeof reviewJpeg>>,
  { textAreas, gutter }: PremiumSpreadReviewAreas,
) {
  const { width, height } = image.info;
  const rectangle = (area: typeof gutter, color: string) =>
    `<rect x="${area.x * width}" y="${area.y * height}" width="${area.width * width}" height="${area.height * height}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2"/>`;
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangle(gutter, '#cf6800')}${textAreas.map((area) => rectangle(area, '#007fcc')).join('')}</svg>`,
  );
  return sharp(image.data)
    .composite([{ input: overlay }])
    .jpeg({ quality: 86 })
    .toBuffer();
}

export async function reviewPremiumImage(
  scope: Scope,
  config: PremiumTextConfig,
  phase: string,
  image: Buffer,
  guide: string,
  references: Buffer[],
  composition: string,
  leftDescription?: string,
  areas?: PremiumSpreadReviewAreas,
  scene?: string,
  requirePictureBookArt = false,
  reportUsage?: (usage: TokenUsageRequest) => Promise<void>,
) {
  const isReferenceSheet = phase === 'references';
  const isStandaloneStoryPage = phase === 'opener' || phase === 'ending';
  const isSpread = phase.startsWith('spread-');
  const coherenceCheck = isReferenceSheet
    ? 'Approve coherentArtwork if all character studies are clearly readable and use a consistent visual style. Intentional spacing or a lineup arrangement is expected here.'
    : isStandaloneStoryPage
      ? 'Approve coherentArtwork if this is a single complete square scene, with a connected background and no panels, inset pictures, borders or folds.'
      : 'Approve coherentArtwork only if it is one continuous illustration with no artificial diptych seam.';
  const compositionChecks = isSpread
    ? [
        `Apply the following placement rules to the first image: ${composition}`,
        'Approve clearTextArea when the specified text overlays would not cover faces, main action or essential objects. Background scenery may occupy those areas.',
        'Approve safeGutter when faces, hands and essential objects are outside the specified central binding area. Background scenery and natural edges may cross the centre.',
        'Approve safeTrim when trimming the outside edges would not cut off faces, hands or essential objects. Background scenery should extend to the edges.',
      ]
    : [`Evaluate safeComposition using these required placement rules: ${composition}.`];
  const compositionSchema = isSpread ? spreadCompositionReview : singleImageReview;
  const schema = requirePictureBookArt
    ? compositionSchema.extend({ childlikeArtwork: z.boolean() })
    : compositionSchema;
  const [firstImage, referenceImages] = await Promise.all([
    reviewJpeg(image),
    Promise.all(references.map(reviewJpeg)),
  ]);
  const markedImage = areas ? await markSpreadReviewAreas(firstImage, areas) : undefined;
  const review = await generatePremiumText<Partial<Record<ReviewCheck, boolean>>>(
    scope,
    config,
    phase,
    [
      isReferenceSheet
        ? 'Inspect the first image as a character lineup on a shared sheet. The other attached images are authoritative likeness references.'
        : 'Inspect the first image as the unmarked illustration.',
      ...(markedImage
        ? [
            'The second image is a copy marked for placement review. The blue rectangles show the text overlays and the orange band shows the gutter. Judge the artwork itself on the unmarked first image. Any images after the marked copy are authoritative character references.',
          ]
        : isReferenceSheet
          ? []
          : ['Any images after the first illustration are authoritative character references.']),
      'Approve noLettering only if there are no letters, printed words, numbered labels, logos or watermarks.',
      coherenceCheck,
      isSpread
        ? 'Use the scene to identify the roles depicted. Approve consistentCharacters when each depicted recurring role with an established appearance matches its likeness in the references and guide, or when the illustration has no such roles. Scene-specific figures without an established likeness may have distinct original appearances. Check only likeness here.'
        : 'Approve consistentCharacters when visible recurring characters agree with the references and guide, or none are shown.',
      ...(isSpread && scene
        ? [`Scene for identifying character roles: ${JSON.stringify(scene)}`]
        : []),
      ...compositionChecks,
      ...(requirePictureBookArt ? [pictureBookArtCheck] : []),
      ...(leftDescription
        ? [
            `Approve leftDescriptionAccurate only when the left half of the first image, viewed alone at trim, visibly supports the child-facing description below. Reject descriptions of events, colours, characters or objects only visible on the right, and descriptions that read as drawing instructions. Description: ${JSON.stringify(leftDescription)}`,
          ]
        : []),
      `Artwork guide: ${guide}`,
    ].join('\n'),
    leftDescription ? schema.extend({ leftDescriptionAccurate: z.boolean() }) : schema,
    [
      firstImage.data,
      ...(markedImage ? [markedImage] : []),
      ...referenceImages.map(({ data }) => data),
    ],
    reportUsage,
  );
  const failedChecks = Object.entries(review)
    .filter(([, passed]) => !passed)
    .map(([check]) => check as ReviewCheck);
  if (failedChecks.length) {
    logger.warn('Premium visual review rejected artwork', {
      phase,
      revision: scope.revision,
      failedChecks,
    });
    throw new PremiumArtworkReviewError(failedChecks);
  }
}
