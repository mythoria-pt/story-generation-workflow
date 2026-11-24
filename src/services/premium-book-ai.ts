import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { z } from 'zod';
import { getEnvironment } from '@/config/environment.js';
import type { TextGenerationUsage } from '@/ai/interfaces.js';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import { TokenUsageTrackingService, type TokenUsageRequest } from './token-usage-tracking.js';
import { PremiumBookError, type PremiumImageConfig } from './premium-book-contract.js';

const qualityReview = z.object({
  noLettering: z.boolean(),
  safeComposition: z.boolean(),
  coherentArtwork: z.boolean(),
  consistentCharacters: z.boolean(),
});

export const premiumTextConfig = z.object({
  provider: z.enum(['openai', 'google-genai']),
  model: z.string().min(1),
});
export type PremiumTextConfig = z.infer<typeof premiumTextConfig>;
type Scope = { storyId: string; ownerId: string; revision: string };

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
): Promise<T> {
  const env = getEnvironment();
  const usage: TextGenerationUsage = {};
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' });
  let result: string;
  if (config.provider === 'openai') {
    const response = await openAI().responses.create({
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
      max_output_tokens: images.length ? 4096 : 8192,
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
      signal: AbortSignal.timeout(200_000),
      maxTokens: 8192,
      thinkingLevel: 'low',
      jsonSchema,
      mediaParts: images.map((image) => ({ mimeType: 'image/jpeg', data: image })),
      usageObserver: (measured) => Object.assign(usage, measured),
    });
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    await new TokenUsageTrackingService().recordUsage({
      authorId: scope.ownerId,
      storyId: scope.storyId,
      action: phase === 'storyboard' ? 'story_outline' : 'image_analysis',
      aiModel: usage.model ?? config.model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      ...(usage.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
      inputPromptJson: { mode: 'premium', revision: scope.revision, phase },
    });
  }
  return parseOutput(schema, result);
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
  const client = openAI(motif ? 90_000 : undefined);
  const params = {
    model: config.model,
    quality: config.quality,
    size,
    prompt,
    n: 1,
    output_format: 'png' as const,
    background: motif ? ('transparent' as const) : ('opaque' as const),
  };
  let output;
  const started = Date.now();
  try {
    output = references.length
      ? await client.images.edit({
          ...params,
          image: await Promise.all(
            references.map((image, index) =>
              toFile(image, `reference-${index}.jpg`, { type: 'image/jpeg' }),
            ),
          ),
        })
      : await client.images.generate(params);
  } catch (error) {
    if (
      error instanceof OpenAI.APIError &&
      ['moderation_blocked', 'content_policy_violation'].includes(error.code ?? '')
    ) {
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
  const encoded = output.data?.[0]?.b64_json;
  if (!encoded) {
    throw new PremiumBookError(
      502,
      'premium_image_missing',
      'Premium image provider returned no art',
    );
  }
  const usage = output.usage;
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

export async function reviewPremiumImage(
  scope: Scope,
  config: PremiumTextConfig,
  phase: string,
  image: Buffer,
  guide: string,
  references: Buffer[],
  composition: string,
  leftDescription?: string,
) {
  const images = await Promise.all(
    [image, ...references].map((buffer) =>
      sharp(buffer)
        .resize({ width: 1300, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toBuffer(),
    ),
  );
  const review = await generatePremiumText(
    scope,
    config,
    phase,
    [
      'Inspect the first illustration visually. The other attached images are authoritative character references.',
      'Approve noLettering only if there are no letters, printed words, numbered labels, logos or watermarks.',
      'Approve coherentArtwork only if it is one continuous illustration with no artificial diptych seam.',
      'Approve consistentCharacters when visible recurring characters agree with the references and guide, or none are shown.',
      `Evaluate safeComposition using these required placement rules: ${composition}.`,
      ...(leftDescription
        ? [
            `Approve leftDescriptionAccurate only when the left half of the first image, viewed alone at trim, visibly supports the child-facing description below. Reject descriptions of events, colours, characters or objects only visible on the right, and descriptions that read as drawing instructions. Description: ${JSON.stringify(leftDescription)}`,
          ]
        : []),
      `Artwork guide: ${guide}`,
    ].join('\n'),
    leftDescription
      ? qualityReview.extend({ leftDescriptionAccurate: z.boolean() })
      : qualityReview,
    images,
  );
  if (Object.values(review).some((ok) => !ok)) {
    throw new PremiumBookError(502, 'premium_artwork_review', 'Premium illustration failed review');
  }
}
