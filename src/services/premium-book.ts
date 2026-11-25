import { and, asc, eq, sql } from 'drizzle-orm';
import type { Bucket } from '@google-cloud/storage';
import sharp from 'sharp';
import { z } from 'zod';
import { getDatabase } from '@/db/connection.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import {
  authors,
  characters,
  stories,
  storyCharacters,
  storyGenerationRequests,
} from '@/db/schema/index.js';
import { getEnvironment } from '@/config/environment.js';
import { normalizeLocale } from '@/config/locales.js';
import { getStorageService } from './storage-singleton.js';
import {
  getWhispererPrivateStorage,
  isScopedWhispererPhoto,
  isWhispererPrivateInput,
  withWhispererDraftAccess,
} from './biographer/whisperer-photos.js';
import { RunsService } from './runs.js';
import { premiumOpeningPages, premiumSpecification } from './premium-book-opening.js';
import { addPremiumPagePreviews } from './premium-book-previews.js';
import { validatePremiumTypesetPages } from './premium-order-proof.js';
import { premiumInvitationPage } from './premium-book-invitation.js';
import { logger } from '@/config/logger.js';
import { selectPremiumOpeningMotif } from './premium-book-motif.js';
import {
  buildPremiumStoryboardPrompt,
  premiumPictureBookArtDirection,
  premiumSpreadScene,
} from './premium-book-storyboard.js';
import {
  generatePremiumImage,
  generatePremiumText,
  getPremiumConfiguration,
  isPremiumLetteringCheck,
  PremiumArtworkReviewError,
  PremiumGuideReviewError,
  premiumReviewCheck,
  premiumReviewGuidance,
  premiumTextConfig,
  reviewPremiumImage,
  reviewPremiumLetteredArtwork,
  reviewPremiumLetteredGuide,
  reviewPremiumSpreadTextPlacement,
} from './premium-book-ai.js';
import {
  createPremiumBlankTile,
  createPremiumNativeSpreadGuides,
  createPremiumSpreadScaffold,
  defaultPremiumSpreadTextBoxes,
  exportIndependentPremiumSpread,
  exportNativePremiumSpread,
  exportPremiumArtwork,
  inspectPremiumOpaquePng,
  lowerPremiumSpreadTextBoxes,
  premiumGeometry,
  premiumSpreadComposition,
  readPremiumNativeTileTrim,
  restoreIndependentPremiumTile,
  restorePremiumNativeTile,
  type PremiumSpreadTextBoxes,
  PREMIUM_NATIVE_PAGE_SIZE,
  PREMIUM_PRINT_PPI,
  PREMIUM_READING_PPI,
} from './premium-book-artwork.js';
import {
  buildPremiumLetteredPagePrompt,
  buildPremiumLetteredPanoramaPrompt,
  buildPremiumNativeCoverPrompt,
  premiumCoverComposition,
  premiumLetteredPageReferences,
  type PremiumLetteredPage,
} from './premium-book-lettering.js';
import {
  applyPremiumSpreadText,
  hasPremiumMarker,
  isPremiumNativePrintArtwork,
  narrativeText,
  LEGACY_PREMIUM_PAGE_COUNT,
  openingPlan,
  PREMIUM_BOOK_TYPE,
  PREMIUM_EMBEDDED_LETTERING_EDITION,
  PREMIUM_FORMAT,
  PREMIUM_PAGE_COUNT,
  PREMIUM_SPREAD_COUNT,
  PREMIUM_TEXT_BOX,
  PremiumBookError,
  premiumAsset,
  premiumAudience,
  premiumBoard,
  generatedPremiumBoard,
  mixedGeneratedPremiumBoard,
  premiumPageRenderMode,
  typesetNarration,
  historicalGeneratedPremiumBoard,
  premiumLeftDescription,
  premiumImageConfig,
  premiumManifest,
  premiumManifestBeforePreviews,
  premiumPage,
  premiumTextBox,
  premiumRevisionPrefix,
  readPremiumMarker,
  premiumTextLayout,
  type PremiumAsset,
  type PremiumManifest,
  type PremiumMarker,
  type PremiumPage,
  type PremiumTextLayout,
} from './premium-book-contract.js';
import {
  deletePremiumReviewDraft,
  getPremiumBucket,
  listPremiumReviewDrafts,
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumManifest,
  readPremiumObject,
  readPremiumReviewDraft,
  savePremiumImage,
  savePremiumObject,
  savePremiumReviewDraft,
  stagePremiumCheckpoint,
  verifyPremiumAssetScope,
  withPremiumLease,
} from './premium-book-storage.js';

const checklist = [
  'storyboard',
  'references',
  'front',
  'back',
  'opener',
  ...Array.from({ length: PREMIUM_SPREAD_COUNT }, (_, index) => `spread-${index + 1}`),
  'ending',
];
export const PREMIUM_LAST_STAGE = checklist.length;
const correctionRequest = z
  .object({
    expectedRevision: z.uuid(),
    correctionId: z.uuid(),
    spreadId: z.string().regex(/^(?:spread-(?:[1-9]|1[0-3])|front|back|opener|ending)$/),
    textLayout: premiumTextLayout.optional(),
    targetSide: z.enum(['left', 'right']).optional(),
    leftText: z.union([typesetNarration, z.literal('')]).optional(),
    rightText: z.union([typesetNarration, z.literal('')]).optional(),
    leftDescription: premiumLeftDescription.optional(),
    artworkInstructions: z.string().trim().min(1).max(1500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.expectedRevision !== value.correctionId &&
      (value.leftText !== undefined ||
        Boolean(value.rightText || value.leftDescription || value.artworkInstructions)),
  );
export { correctionRequest as premiumCorrectionRequest };

const frozenSchema = z
  .object({
    storyId: z.uuid(),
    ownerId: z.uuid(),
    revision: z.uuid(),
    audience: premiumAudience,
    opening: openingPlan.omit({ synopsis: true }),
    direction: z.string(),
    characters: z.string(),
    referenceImages: z.array(premiumAsset).max(5),
    image: premiumImageConfig,
    text: premiumTextConfig,
    invitation: premiumPage.optional(),
    editionLayout: z.literal(PREMIUM_EMBEDDED_LETTERING_EDITION).optional(),
    spreadLayoutVersion: z.literal(1).optional(),
  })
  .refine(
    ({ editionLayout, invitation }) =>
      !editionLayout ||
      (invitation?.kind === 'invitation' && invitation.number === PREMIUM_PAGE_COUNT),
    { path: ['invitation'], message: 'Embedded-lettering editions require an invitation page' },
  );
type FrozenBook = z.infer<typeof frozenSchema>;
const artworkSchema = z.object({
  master: premiumAsset,
  source: premiumAsset,
  printPages: z.array(premiumAsset).min(1).max(2),
  readingPages: z.array(premiumAsset).min(1).max(2),
  spreadTextBoxes: z.object({ left: premiumTextBox.optional(), right: premiumTextBox }).optional(),
  nativeWidth: z.number().int().positive(),
  nativeHeight: z.number().int().positive(),
  effectivePpi: z.number().positive(),
  letteringVerified: z.literal(true).optional(),
});
type Artwork = z.infer<typeof artworkSchema>;

function artworkCheckpointFor(editionLayout: FrozenBook['editionLayout'], phase: string) {
  if (!editionLayout) return artworkSchema;
  const facing = phase.startsWith('spread-');
  const narrative = facing || phase === 'opener' || phase === 'ending';
  const pageCount = facing ? 2 : 1;
  return artworkSchema.refine(
    (art) =>
      isPremiumNativePrintArtwork(art, facing) &&
      art.printPages.length === pageCount &&
      art.readingPages.length === pageCount &&
      Boolean(art.letteringVerified) === narrative &&
      !art.spreadTextBoxes,
    'Artwork checkpoint does not match the embedded-lettering page plan',
  );
}
type StoryRow = typeof stories.$inferSelect;
type Queued = Extract<PremiumMarker, { state: 'queued' }>;
type Published = Extract<PremiumMarker, { state: 'published' }>;
type Scope = {
  storyId: string;
  ownerId: string;
  revision: string;
  editionLayout?: FrozenBook['editionLayout'];
  audience?: FrozenBook['audience'];
  opening?: Pick<FrozenBook['opening'], 'locale'>;
};

const hashJson = (value: unknown) => premiumDigest(JSON.stringify(value));
const checkpointKey = (prefix: string, phase: string) => `${prefix}/checkpoints/${phase}.json`;

function scopeError(code: string, description: string) {
  return new PremiumBookError(409, code, description);
}

const requestIdentity = {
  storyId: storyGenerationRequests.storyId,
  ownerId: storyGenerationRequests.authorId,
  compensatedAt: storyGenerationRequests.compensatedAt,
  status: storyGenerationRequests.status,
};

function verifyEntitlement(
  request:
    | (Pick<typeof storyGenerationRequests.$inferSelect, 'storyId' | 'status' | 'compensatedAt'> & {
        ownerId: string;
      })
    | undefined,
  storyId: string,
  ownerId: string,
) {
  if (
    request?.storyId !== storyId ||
    request.ownerId !== ownerId ||
    request.compensatedAt ||
    ['delivery_failed', 'cancelled'].includes(request.status)
  ) {
    throw scopeError('premium_entitlement', 'No matching accepted premium generation request');
  }
}

async function readStory(storyId: string) {
  const [story] = await getDatabase().select().from(stories).where(eq(stories.storyId, storyId));
  if (!story) throw new PremiumBookError(404, 'premium_story_missing', 'Story does not exist');
  return story;
}

export async function hasPremiumStoryMarker(storyId: string) {
  const [story] = await getDatabase()
    .select({ features: stories.features })
    .from(stories)
    .where(eq(stories.storyId, storyId));
  return hasPremiumMarker(story?.features);
}

async function resolveRun(storyId: string, runId: string, bookType?: string) {
  const story = await readStory(storyId);
  const marker = readPremiumMarker(story.features);
  if (!marker) {
    if (bookType !== undefined)
      throw scopeError('premium_marker_missing', 'Premium request has no saved marker');
    return undefined;
  }
  if (
    (bookType !== undefined && bookType !== PREMIUM_BOOK_TYPE) ||
    marker.state === 'draft' ||
    marker.revision !== runId ||
    marker.ownerId !== story.authorId
  ) {
    throw scopeError('premium_identity', 'Premium marker does not match the requested run');
  }
  const [request] = await getDatabase()
    .select(requestIdentity)
    .from(storyGenerationRequests)
    .where(eq(storyGenerationRequests.runId, runId));
  verifyEntitlement(request, storyId, marker.ownerId);
  return { story, marker };
}

export async function verifyPremiumClaim(storyId: string, runId: string) {
  await resolveRun(storyId, runId, PREMIUM_BOOK_TYPE);
}

async function activatePremiumRun(storyId: string, runId: string, resume = false) {
  await getDatabase().transaction(async (tx) => {
    const [story] = await tx
      .select({ ownerId: stories.authorId, status: stories.status, features: stories.features })
      .from(stories)
      .where(eq(stories.storyId, storyId))
      .for('update');
    const marker = readPremiumMarker(story?.features);
    if (
      story?.status !== 'writing' ||
      marker?.state !== 'queued' ||
      marker.revision !== runId ||
      marker.ownerId !== story.ownerId
    ) {
      throw scopeError(
        'premium_identity',
        'Premium marker was superseded before generation could start',
      );
    }
    const [request] = await tx
      .select(requestIdentity)
      .from(storyGenerationRequests)
      .where(eq(storyGenerationRequests.runId, runId))
      .for('update');
    verifyEntitlement(request, storyId, marker.ownerId);
    if (resume) {
      await tx
        .update(storyGenerationRequests)
        .set({ status: 'published', terminalAt: null, updatedAt: new Date() })
        .where(eq(storyGenerationRequests.runId, runId));
    }
    await tx
      .update(stories)
      .set({ storyGenerationStatus: 'running' })
      .where(eq(stories.storyId, storyId));
  });
}

export async function identifyPremiumRun(
  storyId: string,
  runId: string,
  executionId: string,
  bookType?: string,
) {
  const resolved = await resolveRun(storyId, runId, bookType);
  if (resolved) {
    const runs = new RunsService();
    const run = await runs.getRun(runId);
    if (
      run?.storyId !== storyId ||
      run.status !== 'running' ||
      run.gcpWorkflowExecution !== executionId
    ) {
      throw scopeError('premium_run_invalid', 'Premium workflow run is unavailable');
    }
    await runs.updateRun(runId, {
      currentStep: 'premium_storyboard',
      metadata: { serviceCode: 'storyGeneration', premiumBook: true },
    });
    await activatePremiumRun(storyId, runId);
  }
  return { premium: Boolean(resolved), lastStage: PREMIUM_LAST_STAGE };
}

async function resumeTarget(storyId: string, runId: string) {
  const target = await resolveRun(storyId, runId, PREMIUM_BOOK_TYPE);
  if (!target || target.marker.state !== 'queued' || target.story.status !== 'writing') {
    throw scopeError(
      'premium_resume_invalid',
      'Only an incomplete accepted premium run can resume',
    );
  }
  const run = await new RunsService().getRun(runId);
  if (
    !run ||
    run.storyId !== storyId ||
    (run.status !== 'failed' && run.status !== 'blocked' && run.status !== 'running')
  ) {
    throw scopeError('premium_resume_invalid', 'Premium run cannot resume in its current state');
  }
  return {
    status: run.status,
    updatedAt: run.updatedAt,
    execution: run.gcpWorkflowExecution,
  } as const;
}

async function canResume(target: Awaited<ReturnType<typeof resumeTarget>>): Promise<boolean> {
  if (target.status !== 'running') return true;
  if (!target.execution) return false;
  const prior = await new GoogleCloudWorkflowsAdapter().getWorkflowExecution(target.execution);
  return prior.status === 'failed';
}

export async function resumePremiumRun(storyId: string, runId: string) {
  const prior = await resumeTarget(storyId, runId);
  if (!(await canResume(prior))) {
    return { storyId, runId, active: true };
  }
  const payload = { storyId, runId, bookType: PREMIUM_BOOK_TYPE, resumeUpdatedAt: prior.updatedAt };
  const executionId = await new GoogleCloudWorkflowsAdapter().executeWorkflow(
    'mythoria-story-generation',
    {
      data: { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } },
    },
  );
  return { storyId, runId, executionId };
}

export async function claimPremiumResume(
  storyId: string,
  runId: string,
  updatedAt: string,
  executionId: string,
) {
  const prior = await resumeTarget(storyId, runId);
  if (prior.updatedAt !== updatedAt || !(await canResume(prior))) return { claimed: false };
  const run = await new RunsService().claimPremiumResume(storyId, runId, prior, executionId);
  if (!run) return { claimed: false };
  await activatePremiumRun(storyId, runId, true);
  return { claimed: true };
}

function regularObjectPath(uri: string, bucket: string): string | undefined {
  if (uri.startsWith(`gs://${bucket}/`)) return uri.slice(bucket.length + 6);
  if (uri.startsWith(`https://storage.googleapis.com/${bucket}/`)) {
    return uri.slice(`https://storage.googleapis.com/${bucket}/`.length);
  }
  if (uri.startsWith(`https://${bucket}.storage.googleapis.com/`)) {
    return uri.slice(`https://${bucket}.storage.googleapis.com/`.length);
  }
  return uri.includes('://') ? undefined : uri;
}

async function readOriginal(scope: Scope, uri: string, characterId?: string) {
  const env = getEnvironment();
  const privatePrefix = `gs://${env.BIOGRAPHER_STORAGE_BUCKET}/`;
  const privatePath = uri.startsWith(privatePrefix) ? uri.slice(privatePrefix.length) : uri;
  if (isWhispererPrivateInput(privatePath)) {
    if (!isScopedWhispererPhoto(scope.storyId, privatePath)) {
      throw scopeError(
        'premium_photo_scope',
        'Private premium reference does not belong to this story',
      );
    }
    const { storage } = getWhispererPrivateStorage();
    return withWhispererDraftAccess(scope.ownerId, scope.storyId, () =>
      storage.downloadFileAsBuffer(privatePath),
    );
  }
  const path = regularObjectPath(uri, env.STORAGE_BUCKET_NAME);
  const prefixes = characterId
    ? [`${scope.ownerId}/characters/${characterId}/`, `characters/${scope.ownerId}/${characterId}/`]
    : [`${scope.storyId}/inputs/`, `${scope.storyId}/originals/`];
  if (
    !path ||
    !/^[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/i.test(path) ||
    !prefixes.some((prefix) => path.startsWith(prefix))
  ) {
    throw scopeError(
      'premium_photo_scope',
      'Premium reference does not belong to the story or author',
    );
  }
  return getStorageService().downloadFileAsBuffer(path);
}

async function freezeInput(
  bucket: Bucket,
  prefix: string,
  story: StoryRow,
  marker: Queued,
): Promise<FrozenBook> {
  const scope = { storyId: story.storyId, ownerId: marker.ownerId, revision: marker.revision };
  if (story.status !== 'writing' || story.targetAudience !== marker.audience) {
    throw scopeError(
      'premium_source_changed',
      'Premium draft differs from its accepted audience or status',
    );
  }
  const db = getDatabase();
  const [author] = await db
    .select({ name: authors.displayName })
    .from(authors)
    .where(eq(authors.authorId, marker.ownerId));
  const cast = await db
    .select({ character: characters, role: storyCharacters.role })
    .from(storyCharacters)
    .innerJoin(characters, eq(characters.characterId, storyCharacters.characterId))
    .where(eq(storyCharacters.storyId, story.storyId))
    .orderBy(asc(characters.characterId));
  const references: { uri: string; characterId?: string }[] = [];
  const descriptions = [];
  for (const { character, role } of cast) {
    if (character.authorId && character.authorId !== marker.ownerId) {
      throw scopeError(
        'premium_character_scope',
        'Premium character does not belong to the author',
      );
    }
    if (character.photoGcsUri && character.authorId) {
      references.push({ uri: character.photoGcsUri, characterId: character.characterId });
    }
    descriptions.push({
      name: character.name,
      type: character.type,
      age: character.age,
      role,
      traits: character.traits,
      characteristics: character.characteristics,
      physicalDescription: character.physicalDescription,
    });
  }
  for (const uri of story.coverReferenceUris ?? []) references.push({ uri });
  const photos = [];
  for (const reference of [...new Map(references.map((ref) => [ref.uri, ref])).values()].slice(
    0,
    5,
  )) {
    const original = await readOriginal(scope, reference.uri, reference.characterId);
    if (!original) throw scopeError('premium_photo_missing', 'Premium reference is unavailable');
    const photo = await sharp(original, { limitInputPixels: 45_000_000 })
      .autoOrient()
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    photos.push(await savePremiumImage(bucket, prefix, photo, 'jpg'));
  }
  const locale = normalizeLocale(story.storyLanguage);
  return {
    ...scope,
    audience: marker.audience,
    opening: {
      title: story.title,
      author: story.customAuthor?.trim() || author?.name?.trim() || 'Mythoria',
      locale,
      dedication: story.dedicationMessage ?? '',
      createdAt: story.createdAt.toISOString(),
    },
    direction: JSON.stringify({
      outline: story.plotDescription,
      synopsis: story.synopsis,
      place: story.place,
      additionalRequests: story.additionalRequests,
      imageInstructions: story.imageGenerationInstructions,
      novelStyle: story.novelStyle,
      graphicalStyle: story.graphicalStyle,
      persona: story.literaryPersona,
      customWritingPersona: story.customWritingPersona,
    }),
    characters: JSON.stringify(descriptions),
    referenceImages: photos,
    ...getPremiumConfiguration(),
    invitation: premiumInvitationPage(locale),
    editionLayout: PREMIUM_EMBEDDED_LETTERING_EDITION,
    spreadLayoutVersion: 1,
  };
}

async function readValidated<T>(bucket: Bucket, key: string, schema: z.ZodType<T>): Promise<T> {
  const value = await readPremiumCheckpoint(bucket, key, schema);
  if (value === undefined) {
    throw scopeError(
      'premium_checkpoint_missing',
      'Required premium generation checkpoint is missing',
    );
  }
  return value;
}

async function stage<T>(
  bucket: Bucket,
  prefix: string,
  phase: string,
  inputHash: string,
  schema: z.ZodType<T>,
  create: () => Promise<T>,
) {
  const path = checkpointKey(prefix, phase);
  const envelope = z.object({ inputHash: z.literal(inputHash), result: schema });
  const prior = await readPremiumCheckpoint(bucket, path, envelope);
  if (prior) return prior.result;
  return withPremiumLease(
    bucket,
    path,
    async () =>
      (
        await stagePremiumCheckpoint(bucket, path, envelope, async () => ({
          inputHash,
          result: await create(),
        }))
      ).result,
  );
}

async function getStaged<T>(
  bucket: Bucket,
  prefix: string,
  phase: string,
  inputHash: string,
  schema: z.ZodType<T>,
) {
  return (
    await readValidated(
      bucket,
      checkpointKey(prefix, phase),
      z.object({ inputHash: z.literal(inputHash), result: schema }),
    )
  ).result;
}

const textAreaTop = Math.round(PREMIUM_TEXT_BOX.y * 100);
const textAreaBottom = Math.round((PREMIUM_TEXT_BOX.y + PREMIUM_TEXT_BOX.height) * 100);
const textArea = `from ${textAreaTop}% to ${textAreaBottom}% down and from ${Math.round(PREMIUM_TEXT_BOX.x * 100)}% to ${Math.round((PREMIUM_TEXT_BOX.x + PREMIUM_TEXT_BOX.width) * 100)}% across the trimmed page`;
const squareComposition = `Draw one standalone square illustration of a single moment. Let the light, low-detail background fill the text area ${textArea}. Place the main action below that area and keep faces and important details away from the trim. Fill the entire page with the scene, without insets, panels, borders or a fold.`;
const noText =
  'Never render text, letters, numerals, logos, labels or signatures. Background must reach every edge. Preserve visual consistency with the reference illustrations.';
const spreadShotPlan = z.object({ scene: z.string().trim().min(20).max(1200) });

function artworkAssets(art: Artwork) {
  return [art.master, art.source, ...art.printPages, ...art.readingPages];
}

async function validateAssets(bucket: Bucket, storyId: string, assets: PremiumAsset[]) {
  for (const asset of new Map(assets.map((value) => [value.key, value])).values()) {
    verifyPremiumAssetScope(storyId, asset);
    await readPremiumObject(bucket, asset);
  }
}

type LetteredNarration = { leftText?: string | undefined; rightText?: string | undefined };
type ArtworkSide = PremiumLetteredPage['side'];
type SpreadArtworkPlan = {
  composition?: 'panorama' | 'illustration_facing_text' | 'paired_illustrations' | undefined;
  textLayout?: PremiumTextLayout | undefined;
  leftDescription?: string | undefined;
  rightDescription?: string | undefined;
  leftBrief?: string | undefined;
  rightBrief?: string | undefined;
  textBoxes?: PremiumSpreadTextBoxes;
  typesetBackground?: string | undefined;
};
type ArtworkCorrection = {
  targetSide?: ArtworkSide | undefined;
  previousTiles?: Partial<Record<ArtworkSide, Buffer>>;
};
const letteringFeedback = z.object({
  checks: z.array(premiumReviewCheck),
  attempts: z.object({
    left: z.number().int().nonnegative(),
    right: z.number().int().nonnegative(),
  }),
  guideAttempt: z.number().int().nonnegative().default(0),
  replacementScene: z.string().trim().min(20).max(900).optional(),
  typographyBySide: z
    .object({
      left: z.array(premiumReviewCheck),
      right: z.array(premiumReviewCheck),
    })
    .optional(),
  artworkBySide: z
    .object({
      left: z.array(premiumReviewCheck),
      right: z.array(premiumReviewCheck),
    })
    .optional(),
});
const spreadPlanChecks = new Set<z.infer<typeof premiumReviewCheck>>([
  'centreLine',
  'coherentArtwork',
  'safeGutter',
  'safeTrim',
  'leftDescriptionAccurate',
  'rightDescriptionAccurate',
]);

async function pinLetteringInput(bucket: Bucket, prefix: string, bytes: Buffer, size: string) {
  const { image } = await inspectPremiumOpaquePng(bytes, size);
  // Decode before pinning so a truncated provider image cannot poison a resumed stage.
  await image.stats();
  return savePremiumImage(bucket, prefix, bytes, 'png');
}

async function createLetteredArtwork(
  bucket: Bucket,
  prefix: string,
  scope: Scope,
  image: FrozenBook['image'],
  text: FrozenBook['text'],
  phase: string,
  guide: string,
  action: string,
  reference: Buffer,
  narration: LetteredNarration,
  leftDescription?: string,
  priorImage?: Buffer,
  spread?: SpreadArtworkPlan,
  correction?: ArtworkCorrection,
): Promise<Artwork> {
  const pages: PremiumLetteredPage[] = [];
  if (narration.leftText !== undefined) pages.push({ side: 'left', text: narration.leftText });
  if (narration.rightText !== undefined) pages.push({ side: 'right', text: narration.rightText });
  const [firstPage, secondPage] = pages;
  if (!firstPage || Boolean(secondPage) !== phase.startsWith('spread-')) {
    throw scopeError('premium_lettering_scope', 'Narration does not match the illustrated pages');
  }
  const independent = spread?.composition !== undefined && spread.composition !== 'panorama';
  const artHash = hashJson({
    action,
    guide,
    narration,
    leftDescription,
    ...(spread?.rightDescription && { rightDescription: spread.rightDescription }),
    ...(independent && {
      composition: spread?.composition,
      leftBrief: spread?.leftBrief,
      rightBrief: spread?.rightBrief,
      typesetBackground: spread?.typesetBackground,
      targetSide: correction?.targetSide,
      priorSource: priorImage && premiumDigest(priorImage),
      previousLeft: correction?.previousTiles?.left && premiumDigest(correction.previousTiles.left),
      previousRight:
        correction?.previousTiles?.right && premiumDigest(correction.previousTiles.right),
    }),
  });
  const feedbackKey = `${prefix}/review/${phase}-${artHash}.lettering.json`;
  const previous = (await readPremiumCheckpoint(bucket, feedbackKey, letteringFeedback)) ?? {
    checks: [],
    attempts: { left: 0, right: 0 },
    guideAttempt: 0,
    replacementScene: undefined,
    typographyBySide: undefined,
    artworkBySide: undefined,
  };
  const priorTypography = previous.checks.filter(isPremiumLetteringCheck);
  const priorTypographyBySide = previous.typographyBySide ?? {
    left: priorTypography,
    right: priorTypography,
  };
  const priorArtworkBySide = previous.artworkBySide ?? { left: [], right: [] };
  const pageBrief = (side: ArtworkSide) =>
    side === 'left' ? spread?.leftBrief : spread?.rightBrief;
  const pageDescription = (side: ArtworkSide) =>
    (side === 'left' ? spread?.leftDescription : spread?.rightDescription) || pageBrief(side);
  const otherSide = (side: ArtworkSide) => (side === 'left' ? 'right' : 'left');
  const typesetSide =
    spread?.composition === 'illustration_facing_text'
      ? spread.textLayout === 'left_only'
        ? 'left'
        : 'right'
      : undefined;
  async function renderPage(page: PremiumLetteredPage, crop?: Buffer, plan?: PremiumAsset) {
    if (independent && page.side === typesetSide) {
      return createPremiumBlankTile(spread?.typesetBackground ?? '#fbf5e6');
    }
    const previousTile = correction?.previousTiles?.[page.side];
    if (independent && correction?.targetSide && correction.targetSide !== page.side) {
      if (priorImage) return restoreIndependentPremiumTile(priorImage, page.side);
      if (!previousTile)
        throw scopeError('premium_correction_conflict', 'Missing published facing illustration');
      return restorePremiumNativeTile(previousTile);
    }
    const nearbyTile = correction?.previousTiles?.[otherSide(page.side)];
    const inputHash = hashJson({
      artHash,
      page,
      attempt: previous.attempts[page.side],
      plan: plan?.sha256,
    });
    const asset = await stage(
      bucket,
      prefix,
      `lettering-tile-${phase}-${page.side}-${inputHash}`,
      inputHash,
      premiumAsset,
      async () => {
        const artworkChecks = independent
          ? priorArtworkBySide[page.side]
          : previous.checks.filter((check) => !isPremiumLetteringCheck(check));
        const feedback = premiumReviewGuidance(
          [...artworkChecks, ...priorTypographyBySide[page.side]],
          independent,
        );
        const raw = await generatePremiumImage(
          scope,
          image,
          `${phase}-lettering-${page.side}`,
          buildPremiumLetteredPagePrompt({
            ...page,
            action: independent ? (pageBrief(page.side) ?? action) : action,
            guide,
            facing: Boolean(crop),
            feedback,
            audience: scope.audience,
            locale: scope.opening?.locale,
            hasPrior: !secondPage && Boolean(priorImage),
            independent: independent
              ? {
                  spreadContext: action,
                  hasPrior: Boolean(previousTile),
                  hasNeighbour: Boolean(nearbyTile),
                }
              : undefined,
          }),
          PREMIUM_NATIVE_PAGE_SIZE,
          independent
            ? [
                reference,
                ...(previousTile ? [previousTile] : []),
                ...(nearbyTile ? [nearbyTile] : []),
              ]
            : !secondPage && priorImage
              ? [reference, priorImage]
              : premiumLetteredPageReferences(reference, crop),
        );
        return pinLetteringInput(bucket, prefix, raw, PREMIUM_NATIVE_PAGE_SIZE);
      },
    );
    verifyPremiumAssetScope(scope.storyId, asset);
    return readPremiumObject(bucket, asset);
  }

  let raw: Buffer;
  let art: Awaited<ReturnType<typeof exportPremiumArtwork>>;
  const failedPages: Partial<Record<ArtworkSide, PremiumArtworkReviewError>> = {};
  try {
    if (independent && secondPage) {
      const [left, right] = await Promise.allSettled([
        renderPage(firstPage),
        renderPage(secondPage),
      ]);
      if (left.status === 'rejected') throw left.reason;
      if (right.status === 'rejected') throw right.reason;
      const tiles = { left: left.value, right: right.value };
      const checkedPages = pages.filter(
        ({ side }) =>
          side !== typesetSide && (!correction?.targetSide || side === correction.targetSide),
      );
      if (!checkedPages.length)
        throw scopeError('premium_lettering_scope', 'Correction requires an illustrated page');
      const reviews = await Promise.allSettled(
        checkedPages.map(async (page) => {
          const source = tiles[page.side];
          const neighbour = typesetSide ? undefined : tiles[otherSide(page.side)];
          const reviewHash = hashJson({
            artHash,
            side: page.side,
            source: premiumDigest(source),
            neighbour: neighbour && premiumDigest(neighbour),
          });
          return stage(
            bucket,
            prefix,
            `lettering-tile-review-${phase}-${page.side}-${reviewHash}`,
            reviewHash,
            z.literal(true),
            async () => {
              await reviewPremiumLetteredArtwork(scope, text, `${phase}-${page.side}`, {
                source,
                pages: [{ ...page, trim: await readPremiumNativeTileTrim(source) }],
                reference,
                independent: {
                  side: page.side,
                  description: pageDescription(page.side) ?? action,
                  neighbour,
                  neighbourDescription: pageDescription(otherSide(page.side)),
                },
              });
              return true as const;
            },
          );
        }),
      );
      for (const [index, review] of reviews.entries()) {
        const page = checkedPages[index];
        if (
          page &&
          review.status === 'rejected' &&
          review.reason instanceof PremiumArtworkReviewError
        ) {
          failedPages[page.side] = review.reason;
        }
      }
      const reviewErrors = Object.values(failedPages);
      if (reviewErrors.length) {
        throw new PremiumArtworkReviewError(
          [...new Set(reviewErrors.flatMap((error) => error.failedChecks))],
          reviewErrors.flatMap((error) => error.failedLetteringSides),
          {
            left: failedPages.left?.failedLetteringChecksBySide.left ?? [],
            right: failedPages.right?.failedLetteringChecksBySide.right ?? [],
          },
        );
      }
      const rejected = reviews.find((review) => review.status === 'rejected');
      if (rejected) throw rejected.reason;
      const exported = await exportIndependentPremiumSpread(tiles.left, tiles.right);
      raw = exported.source;
      art = exported;
    } else if (secondPage) {
      const planChecks = previous.checks.filter((check) => spreadPlanChecks.has(check));
      const plannedScene = previous.replacementScene ?? action;
      const planHash = hashJson({
        guide,
        action: plannedScene,
        leftDescription,
        ...(spread?.rightDescription && { rightDescription: spread.rightDescription }),
        planChecks,
        ...(previous.guideAttempt > 0 && { guideAttempt: previous.guideAttempt }),
      });
      const planAsset = await stage(
        bucket,
        prefix,
        `lettering-guide-${phase}-${planHash}`,
        planHash,
        premiumAsset,
        async () => {
          const panorama = await generatePremiumImage(
            scope,
            image,
            `${phase}-lettering-guide`,
            [
              buildPremiumLetteredPanoramaPrompt({
                action: plannedScene,
                guide,
                leftDescription,
                rightDescription: spread?.rightDescription,
                silentLeft: firstPage.text === '',
                silentRight: secondPage.text === '',
              }),
              premiumReviewGuidance(planChecks),
            ].join('\n'),
            image.spreadSize,
            priorImage ? [reference, priorImage] : [reference],
          );
          return pinLetteringInput(bucket, prefix, panorama, image.spreadSize);
        },
      );
      verifyPremiumAssetScope(scope.storyId, planAsset);
      const panorama = await readPremiumObject(bucket, planAsset);
      await stage(
        bucket,
        prefix,
        `lettering-guide-review-${phase}-${planAsset.sha256}`,
        planAsset.sha256,
        z.literal(true),
        async () => {
          await reviewPremiumLetteredGuide(scope, text, phase, panorama, reference, undefined, {
            action,
            leftDescription,
            rightDescription: spread?.rightDescription,
            previousReplacement: previous.replacementScene,
          });
          return true as const;
        },
      );
      const [left, right] = await createPremiumNativeSpreadGuides(panorama);
      // Let both requests settle before the stage lease is released on an error.
      const [leftResult, rightResult] = await Promise.allSettled([
        renderPage(firstPage, left, planAsset),
        renderPage(secondPage, right, planAsset),
      ]);
      if (leftResult.status === 'rejected') throw leftResult.reason;
      if (rightResult.status === 'rejected') throw rightResult.reason;
      const stitched = await exportNativePremiumSpread(leftResult.value, rightResult.value);
      raw = stitched.source;
      art = stitched;
    } else {
      raw = await renderPage(firstPage);
      art = await exportPremiumArtwork(raw, PREMIUM_NATIVE_PAGE_SIZE, false, true);
    }
    if (!independent) {
      const trimmedPages = pages.map((page, index) => {
        const trim = art.readingPages[index];
        if (!trim) throw scopeError('premium_page_missing', 'Premium artwork lacks a trim image');
        return { ...page, trim };
      });
      await reviewPremiumLetteredArtwork(scope, text, phase, {
        source: raw,
        pages: trimmedPages,
        reference,
        leftDescription,
        rightDescription: spread?.rightDescription,
      });
    }
  } catch (error) {
    const reviewError = error instanceof PremiumArtworkReviewError ? error : undefined;
    const failedChecks =
      reviewError?.failedChecks ??
      (error instanceof PremiumBookError && error.code === 'premium_image_join'
        ? (['centreLine'] as const)
        : []);
    if (failedChecks.length) {
      const pageSides = pages.map(({ side }) => side);
      const located =
        reviewError?.failedLetteringSides.filter((side) => pageSides.includes(side)) ?? [];
      const typographyOnly = failedChecks.every(isPremiumLetteringCheck);
      const affectedPages = pageSides.filter((side) => failedPages[side]);
      const retries = affectedPages.length
        ? affectedPages
        : typographyOnly && located.length
          ? located
          : pageSides;
      const attempts = { ...previous.attempts };
      for (const side of retries) attempts[side]++;
      const typographyFailures = failedChecks.filter(isPremiumLetteringCheck);
      const typographyBySide = { ...priorTypographyBySide };
      const artworkBySide = { ...priorArtworkBySide };
      for (const side of pageSides) {
        const findings =
          reviewError?.failedLetteringChecksBySide[side] ??
          (retries.includes(side) ? typographyFailures : []);
        typographyBySide[side] = [...new Set([...typographyBySide[side], ...findings])];
        const artworkFindings = failedPages[side]?.failedChecks.filter(
          (check) => !isPremiumLetteringCheck(check),
        );
        if (artworkFindings?.length) {
          artworkBySide[side] = [...new Set([...artworkBySide[side], ...artworkFindings])];
        }
      }
      const guideAttempt =
        previous.guideAttempt + Number(failedChecks.some((check) => spreadPlanChecks.has(check)));
      const replacementScene =
        error instanceof PremiumGuideReviewError
          ? error.replacementScene
          : previous.replacementScene;
      await bucket
        .file(feedbackKey)
        .save(
          JSON.stringify({
            checks: [...new Set([...previous.checks, ...failedChecks])],
            attempts,
            guideAttempt,
            replacementScene,
            typographyBySide,
            ...(independent && { artworkBySide }),
          }),
          {
            contentType: 'application/json',
            metadata: { cacheControl: 'private,no-store' },
            resumable: false,
          },
        )
        .catch(() =>
          logger.warn('Unable to save premium lettering review feedback', {
            phase,
            revision: scope.revision,
          }),
        );
    }
    throw error;
  }
  const source = await savePremiumImage(bucket, prefix, raw, 'png');
  const master = await savePremiumImage(bucket, prefix, art.readingMaster, 'png');
  const printPages = [];
  const readingPages = [];
  for (const page of art.printPages)
    printPages.push(await savePremiumImage(bucket, prefix, page, 'jpg'));
  for (const page of art.readingPages)
    readingPages.push(await savePremiumImage(bucket, prefix, page, 'png'));
  return { source, master, printPages, readingPages, ...nativeFor(art), letteringVerified: true };
}

async function createArtwork(
  bucket: Bucket,
  prefix: string,
  scope: Scope,
  image: FrozenBook['image'],
  text: FrozenBook['text'],
  phase: string,
  guide: string,
  action: string,
  reference: Buffer,
  spread?: SpreadArtworkPlan,
  priorImage?: Buffer,
  narration?: LetteredNarration,
  correction?: ArtworkCorrection,
): Promise<Artwork> {
  const facing = phase.startsWith('spread-');
  const layout = spread?.textLayout;
  const leftDescription =
    spread?.textLayout === 'right_only' || spread?.textLayout === 'wordless'
      ? spread.leftDescription
      : undefined;
  if (narration) {
    return createLetteredArtwork(
      bucket,
      prefix,
      scope,
      image,
      text,
      phase,
      guide,
      action,
      reference,
      narration,
      leftDescription,
      priorImage,
      spread,
      correction,
    );
  }
  if (spread?.composition && spread.composition !== 'panorama') {
    throw scopeError('premium_lettering_scope', 'Mixed artwork requires a frozen narration plan');
  }
  const requireNative = scope.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
  const pageComposition = ['front', 'back'].includes(phase)
    ? premiumCoverComposition
    : squareComposition;
  const preferredBoxes = facing
    ? (spread?.textBoxes ?? defaultPremiumSpreadTextBoxes(layout))
    : undefined;
  const spreadComposition = preferredBoxes
    ? premiumSpreadComposition(layout, preferredBoxes)
    : undefined;
  const size = facing
    ? image.spreadSize
    : requireNative
      ? PREMIUM_NATIVE_PAGE_SIZE
      : image.squareSize;
  // A retry can land on a new worker. The draft and check names share a frozen shot scope.
  const feedbackPath = `${prefix}/review/${phase}-${hashJson({ action, layout, leftDescription })}`;
  const feedbackKey = `${feedbackPath}.json`;
  const draftKey = `${feedbackPath}.draft.jpg`;
  const [priorChecks, priorDraft] = facing
    ? await Promise.all([
        readPremiumCheckpoint(bucket, feedbackKey, z.array(premiumReviewCheck)),
        readPremiumReviewDraft(bucket, draftKey).catch(() => {
          logger.warn('Unable to read premium spread review draft', {
            phase,
            revision: scope.revision,
          });
          return undefined;
        }),
      ])
    : [];
  const draftChecks = z.array(premiumReviewCheck).safeParse(priorDraft?.failedChecks);
  const shotPlanHash = hashJson({
    version: 2,
    action,
    layout,
    leftDescription,
    guide,
    textBoxes: preferredBoxes,
    checks: priorChecks && [...priorChecks].sort(),
  });
  const shotPlan =
    spreadComposition && priorChecks?.length
      ? await stage(
          bucket,
          prefix,
          `shot-plan-${phase}-${shotPlanHash}`,
          shotPlanHash,
          spreadShotPlan,
          () =>
            generatePremiumText(
              scope,
              text,
              `shot-plan-${phase}`,
              [
                'Plan one feasible, continuous panorama of a single instant. In up to 1200 characters, describe one camera angle and distance, with the visible placement and scale of essential subjects on each half. A shared setting or object can connect the halves.',
                'Preserve the story event, established likenesses and visual clues. Use the layout guidance and review feedback to choose the staging. Return only the visual scene an illustrator should paint. Use qualitative directions such as lower left or farther back. Omit measurements, percentages, coordinates, annotations and printing or page-layout terminology.',
                ...(leftDescription
                  ? [
                      'Place the essential details described for the silent left page well inside the left half so they are recognizable when it is viewed on its own.',
                    ]
                  : []),
                spreadComposition.generation,
                `Review feedback: ${premiumReviewGuidance(priorChecks)}`,
                `Frozen visual inputs: ${JSON.stringify({ action, leftDescription, guide })}`,
              ].join('\n'),
              spreadShotPlan,
            ),
        )
      : undefined;
  const references = [
    ...(priorDraft?.image ? [priorDraft.image] : []),
    ...(priorImage ? [priorImage] : []),
    reference,
  ];
  if (preferredBoxes)
    references.push(await createPremiumSpreadScaffold(size, layout, preferredBoxes));
  const raw = await generatePremiumImage(
    scope,
    image,
    phase,
    requireNative
      ? buildPremiumNativeCoverPrompt({ guide, action })
      : [
          'Illustrate a premium children’s picture book.',
          spreadComposition?.generation ?? pageComposition,
          noText,
          ...(['opener', 'ending'].includes(phase)
            ? [
                'Use the attached lineup only for character likeness and visual style. Do not copy its layout or neutral backdrop. Illustrate only the moment described in Scene.',
              ]
            : []),
          ...(facing
            ? [
                'Use the character sheet for visual style and for the likeness of recurring characters called for in Scene. Depict the roles needed for that moment. Give scene-specific figures without an established likeness distinct original appearances.',
              ]
            : []),
          ...(facing
            ? [
                'Use the final grayscale image only to judge where the scene can hold subjects. Its soft clusters mark possible staging areas and do not specify subject count. Give the whole scene a continuous painted background. Omit the reference layout graphics and use the style and palette of the character reference instead.',
              ]
            : []),
          `Shared visual guide: ${guide}`,
          `Scene: ${shotPlan?.scene ?? action}`,
          ...(leftDescription
            ? [
                `Make the described details visible within the left crop at trim using the scene’s camera and staging: ${JSON.stringify(leftDescription)}. Keep the words themselves out of the art.`,
              ]
            : []),
          ...(priorDraft?.image
            ? [
                'The first image is the rejected previous draft. Edit that illustration to address the specific review feedback. Keep the scene, composition, palette and other details wherever they already meet the requirements. Correct the areas that failed, even if this requires changing their placement or scale. Match recurring characters to the character sheet.',
              ]
            : []),
          ...(draftChecks.success && draftChecks.data.length
            ? [
                `Repair these findings in the previous draft: ${premiumReviewGuidance(draftChecks.data)}`,
              ]
            : []),
          ...(priorImage
            ? [
                priorDraft?.image
                  ? 'The second image is the current published spread. Preserve its character likeness and story details outside the requested whole-spread correction.'
                  : shotPlan
                    ? 'The first reference is the current spread. Preserve character likeness and undiscussed story details. Use the planned camera angle and staging.'
                    : 'The first reference is the complete current spread. Make the requested whole-spread correction. Preserve the overall composition and all undiscussed details.',
              ]
            : []),
          ...(priorChecks?.length
            ? [
                `${priorDraft?.image ? 'Recheck these requirements after the edits' : 'Give particular care to these checks on this attempt'}: ${premiumReviewGuidance(priorChecks)}`,
              ]
            : []),
        ].join('\n'),
    size,
    references,
  );
  const saveReviewFeedback = async (
    failedChecks: readonly z.infer<typeof premiumReviewCheck>[],
  ) => {
    const checks = [...new Set([...(priorChecks ?? []), ...failedChecks])];
    if (checks.length === priorChecks?.length) return;
    await bucket
      .file(feedbackKey)
      .save(JSON.stringify(checks), {
        contentType: 'application/json',
        metadata: { cacheControl: 'private,no-store' },
        resumable: false,
      })
      .catch(() =>
        logger.warn('Unable to save premium spread review feedback', {
          phase,
          revision: scope.revision,
        }),
      );
  };
  const saveReviewDraft = (
    image: Buffer,
    failedChecks: readonly z.infer<typeof premiumReviewCheck>[],
  ) =>
    savePremiumReviewDraft(bucket, draftKey, image, priorDraft?.generation, failedChecks).catch(
      () =>
        logger.warn('Unable to save premium spread review draft', {
          phase,
          revision: scope.revision,
        }),
    );
  const art = await exportPremiumArtwork(raw, size, facing, requireNative).catch(
    async (error: unknown) => {
      if (facing && error instanceof PremiumBookError && error.code === 'premium_image_join') {
        await Promise.all([
          saveReviewFeedback(['centreLine']),
          saveReviewDraft(raw, ['centreLine']),
        ]);
      }
      throw error;
    },
  );
  const review = (
    composition: string,
    areas?: ReturnType<typeof premiumSpreadComposition>['reviewAreas'],
  ) =>
    reviewPremiumImage(
      scope,
      text,
      phase,
      art.readingMaster,
      guide,
      [reference],
      composition,
      leftDescription,
      areas,
      facing ? action : undefined,
      requireNative,
    );
  let spreadTextBoxes: PremiumSpreadTextBoxes | undefined;
  try {
    if (preferredBoxes) {
      const lowerBoxes = lowerPremiumSpreadTextBoxes(preferredBoxes);
      const lowerAlready =
        lowerBoxes.left?.y === preferredBoxes.left?.y &&
        lowerBoxes.right.y === preferredBoxes.right.y;
      const placement = await reviewPremiumSpreadTextPlacement(
        async (candidate) => {
          const boxes = candidate === 'bottom' ? lowerBoxes : preferredBoxes;
          const composition = premiumSpreadComposition(layout, boxes);
          await review(composition.review, composition.reviewAreas);
        },
        lowerAlready ? 'bottom' : 'top',
      );
      spreadTextBoxes = placement === 'bottom' ? lowerBoxes : preferredBoxes;
    } else {
      await review(pageComposition);
    }
  } catch (error) {
    if (facing && error instanceof PremiumArtworkReviewError) {
      await Promise.all([
        saveReviewFeedback(error.failedChecks),
        saveReviewDraft(art.readingMaster, error.failedChecks),
      ]);
    }
    throw error;
  }
  const source = await savePremiumImage(bucket, prefix, raw, 'png');
  const master = await savePremiumImage(bucket, prefix, art.readingMaster, 'png');
  const printPages = [];
  const readingPages = [];
  for (const page of art.printPages)
    printPages.push(await savePremiumImage(bucket, prefix, page, 'jpg'));
  for (const page of art.readingPages)
    readingPages.push(await savePremiumImage(bucket, prefix, page, 'png'));
  if (priorDraft) {
    await deletePremiumReviewDraft(bucket, draftKey, priorDraft.generation).catch(() =>
      logger.warn('Unable to delete premium spread review draft', {
        phase,
        revision: scope.revision,
      }),
    );
  }
  return {
    source,
    master,
    printPages,
    readingPages,
    spreadTextBoxes,
    nativeWidth: art.nativeWidth,
    nativeHeight: art.nativeHeight,
    effectivePpi: art.effectivePpi,
  };
}

function sceneFor(phase: string, board: z.infer<typeof premiumBoard>) {
  if (phase === 'front' || phase === 'back') return board[phase];
  if (phase === 'opener' || phase === 'ending') return board[phase].action;
  const spread = board.spreads[Number(phase.split('-')[1]) - 1];
  if (!spread) throw scopeError('premium_phase_invalid', 'Premium artwork stage is invalid');
  return premiumSpreadScene(spread.action);
}

function pageArt(art: Artwork, index: number, facing: boolean) {
  const artwork = art.printPages[index];
  const reading = art.readingPages[index];
  const digitalCrop = premiumGeometry(PREMIUM_READING_PPI, facing).reading[facing ? index : 0];
  const printCrop = premiumGeometry(PREMIUM_PRINT_PPI, facing).print[facing ? index : 0];
  if (!artwork || !reading || !digitalCrop || !printCrop) {
    throw scopeError('premium_page_missing', 'Premium artwork lacks a required page');
  }
  return { artwork, reading, digitalCrop, printCrop };
}

function nativeFor({
  nativeWidth,
  nativeHeight,
  effectivePpi,
}: Pick<Artwork, 'nativeWidth' | 'nativeHeight' | 'effectivePpi'>) {
  return { nativeWidth, nativeHeight, effectivePpi };
}

async function writeManifest(bucket: Bucket, prefix: string, manifest: PremiumManifest) {
  return savePremiumObject(
    bucket,
    `${prefix}/manifest.json`,
    Buffer.from(JSON.stringify(premiumManifest.parse(manifest))),
    'application/json',
  );
}

async function publishManifest(
  bucket: Bucket,
  prefix: string,
  manifest: PremiumManifest,
  prior: Queued | Published,
) {
  const checked = premiumManifest.parse(manifest);
  const asset = await writeManifest(bucket, prefix, checked);
  await getDatabase().transaction(async (tx) => {
    const [story] = await tx
      .select({ authorId: stories.authorId, status: stories.status, features: stories.features })
      .from(stories)
      .where(eq(stories.storyId, checked.storyId))
      .for('update');
    const marker = readPremiumMarker(story?.features);
    if (story?.authorId !== checked.ownerId || !marker || marker.state === 'draft') {
      throw scopeError('premium_publish_story', 'Premium story is unavailable for publication');
    }
    if (
      marker.state === 'published' &&
      marker.revision === checked.revision &&
      marker.manifest.sha256 === asset.sha256 &&
      marker.manifest.generation === asset.generation
    )
      return;
    if (
      marker.state !== prior.state ||
      marker.revision !== prior.revision ||
      marker.ownerId !== prior.ownerId ||
      marker.audience !== prior.audience ||
      story.status !== (prior.state === 'queued' ? 'writing' : 'published') ||
      (prior.state === 'published' &&
        marker.state === 'published' &&
        marker.manifest.generation !== prior.manifest.generation)
    ) {
      throw scopeError(
        'premium_publish_conflict',
        'Published premium revision changed; reload and review it',
      );
    }
    const updated: Published = {
      ...prior,
      state: 'published',
      revision: checked.revision,
      manifest: asset,
    };
    await tx
      .update(stories)
      .set({
        features: { ...(story.features as Record<string, unknown>), premiumBook: updated },
        synopsis: checked.opening.synopsis,
        ...(prior.state === 'queued' && {
          status: 'published',
          storyGenerationStatus: 'completed',
          storyGenerationCompletedPercentage: 100,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(stories.storyId, checked.storyId), eq(stories.authorId, checked.ownerId)));
  });
  return asset;
}

async function verifyManifestArtwork(bucket: Bucket, manifest: PremiumManifest) {
  await validateAssets(bucket, manifest.storyId, [
    manifest.reference,
    ...(manifest.motifArtwork ? [manifest.motifArtwork] : []),
    ...Object.values(manifest.covers),
    ...manifest.spreads.flatMap((spread) => [spread.master, spread.source]),
    ...manifest.pages.flatMap((page) =>
      [page.artwork, page.reading].filter((asset) => asset !== undefined),
    ),
  ]);
}

async function assemble(
  bucket: Bucket,
  prefix: string,
  book: FrozenBook,
  board: z.infer<typeof premiumBoard>,
) {
  const inputHash = hashJson(book);
  const reference = await getStaged(bucket, prefix, 'references', inputHash, premiumAsset);
  const opening = { ...book.opening, synopsis: board.synopsis };
  const embeddedLettering = book.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
  const pages: PremiumPage[] = premiumOpeningPages(opening);
  const spreads: PremiumManifest['spreads'] = [];
  const covers: Partial<PremiumManifest['covers']> = {};
  const natives: PremiumManifest['natives'] = {};
  for (const phase of checklist.slice(2)) {
    const artwork = await getStaged(
      bucket,
      prefix,
      phase,
      inputHash,
      artworkCheckpointFor(book.editionLayout, phase),
    );
    natives[phase] = nativeFor(artwork);
    if (phase === 'front' || phase === 'back') {
      covers[phase] = pageArt(artwork, 0, false).artwork;
    } else if (phase === 'opener' || phase === 'ending') {
      pages.push({
        number: phase === 'opener' ? 5 : LEGACY_PREMIUM_PAGE_COUNT,
        kind: phase,
        text: board[phase].text,
        ...(!embeddedLettering && { textBox: PREMIUM_TEXT_BOX }),
        ...pageArt(artwork, 0, false),
      });
    } else {
      const index = Number(phase.split('-')[1]) - 1;
      const spread = board.spreads[index];
      if (!spread)
        throw scopeError('premium_spread_missing', 'Premium spread is missing from the storyboard');
      const leftPage = 6 + index * 2;
      const mixed = spread.composition;
      spreads.push({
        id: phase,
        leftPage,
        rightPage: leftPage + 1,
        master: artwork.master,
        source: artwork.source,
        action: spread.action,
        textLayout: spread.textLayout,
        ...(mixed && {
          composition: mixed,
          rationale: spread.rationale,
          leftBrief: spread.leftBrief,
          rightBrief: spread.rightBrief,
        }),
        ...(spread.leftDescription && { leftDescription: spread.leftDescription }),
        ...(spread.rightDescription && { rightDescription: spread.rightDescription }),
        ...nativeFor(artwork),
      });
      for (const [tile, side] of (['left', 'right'] as const).entries()) {
        const renderMode = mixed && premiumPageRenderMode(mixed, spread.textLayout, side);
        pages.push({
          number: leftPage + tile,
          kind: 'spread',
          spreadId: phase,
          text: spread[`${side}Text`],
          ...(renderMode && { renderMode }),
          ...(!embeddedLettering &&
            (side === 'right' || spread.textLayout === 'both_pages') && {
              textBox: artwork.spreadTextBoxes?.[side] ?? PREMIUM_TEXT_BOX,
            }),
          ...(renderMode !== 'typeset' && pageArt(artwork, tile, !mixed || mixed === 'panorama')),
        });
      }
    }
  }
  if (book.invitation) pages.push(book.invitation);
  const motifSpread = board.motifSpread && spreads[board.motifSpread - 1];
  const motifArtwork =
    book.invitation && board.openingDesign && board.motifBrief && motifSpread
      ? await selectPremiumOpeningMotif({
          bucket,
          prefix,
          scope: book,
          bookInputHash: inputHash,
          config: book.image,
          brief: board.motifBrief,
          guide: board.visualGuide,
          spread: motifSpread.master,
          background: board.openingDesign.background,
        })
      : undefined;
  const manifest = premiumManifestBeforePreviews.parse({
    version: 1,
    type: PREMIUM_BOOK_TYPE,
    storyId: book.storyId,
    ownerId: book.ownerId,
    revision: book.revision,
    ...(book.editionLayout && { editionLayout: book.editionLayout }),
    ...(book.spreadLayoutVersion && {
      spreadLayoutVersion: book.spreadLayoutVersion,
      audience: book.audience,
    }),
    format: {
      ...PREMIUM_FORMAT,
      pageCount: book.invitation ? PREMIUM_PAGE_COUNT : LEGACY_PREMIUM_PAGE_COUNT,
    },
    opening,
    ...(embeddedLettering && { specification: premiumSpecification(opening) }),
    ...(board.openingDesign && { openingDesign: board.openingDesign }),
    ...(motifArtwork && { motifArtwork }),
    config: book.image,
    textConfig: book.text,
    inputHash,
    visualGuide: board.visualGuide,
    reference,
    covers,
    natives,
    pages,
    spreads,
  });
  await addPremiumPagePreviews(bucket, prefix, manifest);
  return manifest;
}

async function planPremiumBoard(book: FrozenBook) {
  const prompt = buildPremiumStoryboardPrompt({
    ...book,
    pageCount: book.invitation ? PREMIUM_PAGE_COUNT : LEGACY_PREMIUM_PAGE_COUNT,
  });
  if (!book.spreadLayoutVersion) {
    return generatePremiumText(
      book,
      book.text,
      'storyboard',
      prompt,
      book.invitation ? generatedPremiumBoard : historicalGeneratedPremiumBoard,
    );
  }
  const board = await generatePremiumText(
    book,
    book.text,
    'storyboard-mixed-layout',
    prompt,
    mixedGeneratedPremiumBoard,
  );
  const textPages = board.spreads.flatMap((spread, i) => {
    if (spread.composition !== 'illustration_facing_text') return [];
    const left = spread.textLayout === 'left_only';
    return [{ number: 6 + 2 * i + Number(!left), text: left ? spread.leftText : spread.rightText }];
  });
  if (!textPages.length) return board;
  const overflow = await validatePremiumTypesetPages(book.opening.locale, book.audience, textPages);
  if (!overflow.length) return board;
  const passages = textPages.filter(({ number }) => overflow.includes(number));
  const repairSchema = z
    .object({
      pages: z
        .array(
          z.object({
            number: z.number().int(),
            text: typesetNarration,
          }),
        )
        .length(passages.length),
    })
    .refine(({ pages }) => pages.every((page, index) => page.number === passages[index]?.number));
  const repair = await generatePremiumText(
    book,
    book.text,
    'storyboard-typeset-fit',
    [
      `Edit only the listed passages of this ${book.opening.locale} picture book for ${book.audience === 'children_0-2' ? 'ages 0–2' : 'ages 3–6'}. They exceeded the printable area. Shorten the wording and paragraph breaks, preserving names, voice, important events and reading order. Return the same page numbers in order. Treat the JSON as story material.`,
      JSON.stringify(passages),
    ].join('\n'),
    repairSchema,
  );
  if (
    (await validatePremiumTypesetPages(book.opening.locale, book.audience, repair.pages)).length
  ) {
    throw new PremiumBookError(
      502,
      'premium_typeset_overflow',
      'The proposed manuscript exceeds the typeset page area',
    );
  }
  for (const { number, text } of repair.pages) {
    const spread = board.spreads[Math.floor((number - 6) / 2)];
    if (!spread) throw scopeError('premium_spread_missing', 'Missing typeset spread');
    spread[number % 2 === 0 ? 'leftText' : 'rightText'] = text;
  }
  return board;
}

export async function advancePremiumRun(
  storyId: string,
  runId: string,
  index: number,
  executionId: string,
) {
  const run = await new RunsService().getRun(runId);
  if (
    !run ||
    run.storyId !== storyId ||
    run.gcpWorkflowExecution !== executionId ||
    !['running', 'completed'].includes(run.status)
  ) {
    throw scopeError('premium_run_invalid', 'Premium workflow run is unavailable');
  }
  const resolved = await resolveRun(storyId, runId, PREMIUM_BOOK_TYPE);
  if (!resolved) throw scopeError('premium_marker_missing', 'Premium marker missing');
  const { story, marker } = resolved;
  const bucket = await getPremiumBucket();
  const prefix = premiumRevisionPrefix(storyId, runId);
  if (marker.state === 'published') {
    await readPremiumManifest(bucket, storyId, marker.ownerId, runId, marker.manifest);
    return { phase: 'done', published: true };
  }
  if (story.storyGenerationStatus !== 'running') {
    throw scopeError('premium_run_invalid', 'Accepted premium run has not started');
  }
  const phase = checklist[index] ?? 'publish';
  const snapshotKey = checkpointKey(prefix, 'input');
  const book =
    index === 0
      ? await stage(bucket, prefix, 'input', runId, frozenSchema, () =>
          freezeInput(bucket, prefix, story, marker),
        )
      : (
          await readValidated(
            bucket,
            snapshotKey,
            z.object({ inputHash: z.literal(runId), result: frozenSchema }),
          )
        ).result;
  if (
    book.storyId !== storyId ||
    book.revision !== runId ||
    book.ownerId !== marker.ownerId ||
    book.audience !== marker.audience
  ) {
    throw scopeError('premium_input_identity', 'Frozen premium input does not match the request');
  }
  const inputHash = hashJson(book);
  const storyboardSchema = book.spreadLayoutVersion ? mixedGeneratedPremiumBoard : premiumBoard;
  if (phase === 'storyboard') {
    await stage<z.infer<typeof premiumBoard>>(
      bucket,
      prefix,
      phase,
      inputHash,
      storyboardSchema,
      () => planPremiumBoard(book),
    );
  } else {
    const board = await getStaged<z.infer<typeof premiumBoard>>(
      bucket,
      prefix,
      'storyboard',
      inputHash,
      storyboardSchema,
    );
    if (phase === 'references') {
      await stage(bucket, prefix, phase, inputHash, premiumAsset, async () => {
        const pictureBookArt = book.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
        const originals = [];
        for (const asset of book.referenceImages) {
          verifyPremiumAssetScope(storyId, asset);
          originals.push(await readPremiumObject(bucket, asset));
        }
        const raw = await generatePremiumImage(
          book,
          book.image,
          phase,
          [
            `Create a consistent visual reference sheet for a children's picture book: the recurring cast clearly separated, with the required appearance, style and palette. No lettering. Use original photos as likeness references only. Character and style guide: ${board.visualGuide}\nCharacters: ${book.characters}`,
            ...(pictureBookArt ? [premiumPictureBookArtDirection] : []),
          ].join('\n'),
          book.image.squareSize,
          originals,
        );
        const info = await sharp(raw, { limitInputPixels: 16_000_000 }).metadata();
        if (`${info.width}x${info.height}` !== book.image.squareSize || info.hasAlpha) {
          throw new PremiumBookError(
            502,
            'premium_reference_dimensions',
            'Premium character reference is invalid',
          );
        }
        await reviewPremiumImage(
          book,
          book.text,
          phase,
          raw,
          board.visualGuide,
          originals,
          'Recurring characters are visually distinguishable and each has ample space.',
          undefined,
          undefined,
          undefined,
          pictureBookArt,
        );
        const reference = await sharp(raw).toColourspace('srgb').jpeg({ quality: 95 }).toBuffer();
        return savePremiumImage(bucket, prefix, reference, 'jpg');
      });
    } else if (phase === 'publish') {
      const manifest = await assemble(bucket, prefix, book, board);
      await verifyManifestArtwork(bucket, manifest);
      const current = await new RunsService().getRun(runId);
      if (current?.gcpWorkflowExecution !== executionId || current.status !== 'running') {
        throw scopeError(
          'premium_run_invalid',
          'Premium publication belongs to a superseded execution',
        );
      }
      await publishManifest(bucket, prefix, manifest, marker);
    } else {
      const reference = await getStaged(bucket, prefix, 'references', inputHash, premiumAsset);
      verifyPremiumAssetScope(storyId, reference);
      const ref = await readPremiumObject(bucket, reference);
      const spread = phase.startsWith('spread-')
        ? board.spreads[Number(phase.split('-')[1]) - 1]
        : undefined;
      const narration =
        book.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION
          ? phase === 'opener'
            ? { rightText: board.opener.text }
            : phase === 'ending'
              ? { leftText: board.ending.text }
              : spread && { leftText: spread.leftText, rightText: spread.rightText }
          : undefined;
      const schema = artworkCheckpointFor(book.editionLayout, phase);
      const art = await stage(bucket, prefix, phase, inputHash, schema, () =>
        createArtwork(
          bucket,
          prefix,
          book,
          book.image,
          book.text,
          phase,
          board.visualGuide,
          phase.startsWith('spread-')
            ? sceneFor(phase, board)
            : `${sceneFor(phase, board)}\nStyle direction: ${book.direction}`,
          ref,
          spread && { ...spread, typesetBackground: board.openingDesign?.background },
          undefined,
          narration,
        ),
      );
      await validateAssets(bucket, storyId, artworkAssets(art));
    }
  }
  const currentStep =
    phase === 'storyboard'
      ? 'premium_storyboard'
      : phase === 'publish'
        ? 'premium_publish'
        : 'premium_illustration';
  await new RunsService().updateRun(runId, {
    currentStep,
    metadata: { serviceCode: 'storyGeneration', premiumBook: true },
  });
  const percent = Math.round(((index + 1) / (PREMIUM_LAST_STAGE + 1)) * 99);
  await getDatabase()
    .update(stories)
    .set({
      storyGenerationStatus: 'running',
      storyGenerationCompletedPercentage: sql`greatest(${stories.storyGenerationCompletedPercentage}, ${percent})`,
    })
    .where(
      and(
        eq(stories.storyId, storyId),
        eq(stories.status, 'writing'),
        sql`${stories.features}->'premiumBook'->>'revision' = ${runId}`,
      ),
    );
  return { phase, published: phase === 'publish' };
}

export async function resolvePremiumTerminalStatus(
  storyId: string,
  runId: string,
  status: 'completed' | 'failed' | 'blocked',
) {
  const story = await readStory(storyId);
  const marker = readPremiumMarker(story.features);
  if (marker?.state === 'published' && marker.revision === runId && story.status === 'published')
    return 'completed';
  if (status === 'completed') {
    throw scopeError(
      'premium_unpublished',
      'Premium run cannot complete without a published revision',
    );
  }
  return status;
}

export async function markPremiumTerminalFailure(
  storyId: string,
  runId: string,
  executionId: string,
) {
  await getDatabase().transaction(async (tx) => {
    const [story] = await tx
      .select({ status: stories.status, features: stories.features })
      .from(stories)
      .where(eq(stories.storyId, storyId))
      .for('update');
    const marker = readPremiumMarker(story?.features);
    if (story?.status !== 'writing' || marker?.state !== 'queued' || marker.revision !== runId)
      return;
    const latest = await new RunsService().getRun(runId);
    if (
      latest?.gcpWorkflowExecution !== executionId ||
      (latest.status !== 'failed' && latest.status !== 'blocked')
    )
      return;
    await tx
      .update(stories)
      .set({ storyGenerationStatus: 'failed' })
      .where(eq(stories.storyId, storyId));
  });
}

export async function cleanPremiumTerminalDrafts(
  storyId: string,
  runId: string,
  executionId: string,
) {
  const runs = new RunsService();
  const isTerminalExecution = async () => {
    const run = await runs.getRun(runId);
    return (
      run?.storyId === storyId &&
      run.gcpWorkflowExecution === executionId &&
      (run.status === 'completed' || run.status === 'cancelled')
    );
  };
  if (!(await isTerminalExecution())) return;
  const bucket = await getPremiumBucket();
  const drafts = await listPremiumReviewDrafts(bucket, storyId, runId);
  if (!drafts.length || !(await isTerminalExecution())) return;
  await Promise.all(
    drafts.map(({ key, generation }) => deletePremiumReviewDraft(bucket, key, generation)),
  );
}

export async function correctPremiumSpread(
  storyId: string,
  input: z.infer<typeof correctionRequest>,
  prepareOnly = false,
) {
  const story = await readStory(storyId);
  const marker = readPremiumMarker(story.features);
  if (
    story.status !== 'published' ||
    marker?.state !== 'published' ||
    marker.ownerId !== story.authorId ||
    ![input.correctionId, input.expectedRevision].includes(marker.revision)
  ) {
    throw scopeError(
      'premium_correction_conflict',
      'Premium correction requires the current published revision',
    );
  }
  const bucket = await getPremiumBucket();
  const prefix = premiumRevisionPrefix(storyId, input.correctionId);
  const inputHash = hashJson(input);
  if (marker.revision === input.correctionId) {
    const winner = await readPremiumManifest(
      bucket,
      storyId,
      marker.ownerId,
      input.correctionId,
      marker.manifest,
    );
    if (winner.supersedes !== inputHash) {
      throw scopeError('premium_correction_conflict', 'Premium correction ID is already bound');
    }
    return { revision: winner.revision, manifest: marker.manifest };
  }
  const current = await readPremiumManifest(
    bucket,
    storyId,
    marker.ownerId,
    marker.revision,
    marker.manifest,
  );
  const phase = input.spreadId;
  if (phase === 'front' || phase === 'back' || phase === 'opener' || phase === 'ending') {
    if (
      !input.artworkInstructions ||
      input.leftText !== undefined ||
      input.rightText !== undefined ||
      input.leftDescription !== undefined ||
      input.targetSide !== undefined ||
      input.textLayout !== undefined
    ) {
      throw scopeError(
        'premium_correction_invalid',
        'Single-page corrections require illustration instructions',
      );
    }
    const page = current.pages.find((entry) => entry.kind === phase);
    const existing = phase === 'front' || phase === 'back' ? current.covers[phase] : page?.artwork;
    if (!existing) throw scopeError('premium_page_missing', 'Illustration unavailable');
    verifyPremiumAssetScope(storyId, existing);
    const guide = await readPremiumObject(bucket, existing);
    const embedded = current.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
    const narration =
      embedded && page
        ? phase === 'ending'
          ? { leftText: page.text }
          : { rightText: page.text }
        : undefined;
    const scope = {
      storyId,
      ownerId: marker.ownerId,
      revision: input.correctionId,
      audience: marker.audience,
      opening: current.opening,
      editionLayout: current.editionLayout,
    };
    const art = await stage(
      bucket,
      prefix,
      phase,
      inputHash,
      artworkCheckpointFor(current.editionLayout, phase),
      () =>
        createArtwork(
          bucket,
          prefix,
          scope,
          current.config,
          current.textConfig,
          phase,
          current.visualGuide,
          `Edit the supplied existing illustration. Preserve all unmentioned features. Requested change: ${input.artworkInstructions}`,
          guide,
          undefined,
          undefined,
          narration,
        ),
    );
    const changed = pageArt(art, 0, false);
    if (phase === 'front' || phase === 'back') current.covers[phase] = changed.artwork;
    else if (page) Object.assign(page, changed);
    current.natives[phase] = nativeFor(art);
  } else {
    const spread = current.spreads.find((entry) => entry.id === input.spreadId);
    if (!spread) throw scopeError('premium_spread_missing', 'Premium spread does not exist');
    const left = current.pages[spread.leftPage - 1];
    const right = current.pages[spread.rightPage - 1];
    if (!left || !right)
      throw scopeError('premium_page_missing', 'Premium spread has a missing page');
    const embeddedLettering = current.editionLayout === PREMIUM_EMBEDDED_LETTERING_EDITION;
    const previousLeftText = left.text;
    const previousRightText = right.text;
    const previousLeftDescription = spread.leftDescription;
    const independent = Boolean(spread.composition && spread.composition !== 'panorama');
    let targetSide = input.targetSide;
    if (
      targetSide &&
      (!independent ||
        (targetSide === 'left' ? left : right).renderMode === 'typeset' ||
        input[targetSide === 'left' ? 'rightText' : 'leftText'] !== undefined ||
        (targetSide === 'right' && input.leftDescription !== undefined))
    ) {
      throw scopeError(
        'premium_correction_layout',
        'Select an illustrated page in this composition',
      );
    }
    if (spread.composition) {
      if (
        (input.textLayout && input.textLayout !== spread.textLayout) ||
        (input.leftDescription && left.renderMode !== 'illustration')
      ) {
        throw scopeError(
          'premium_correction_layout',
          'This edit must preserve the frozen page roles',
        );
      }
      for (const [side, page] of [
        ['left', left],
        ['right', right],
      ] as const) {
        const words = input[`${side}Text`];
        if (words === undefined || words === page.text) continue;
        if (
          page.renderMode === 'illustration' ||
          !(page.renderMode === 'typeset' ? typesetNarration : narrativeText).safeParse(words)
            .success
        ) {
          throw scopeError(
            'premium_correction_layout',
            'Narration does not fit its assigned page role',
          );
        }
        page.text = words;
        if (page.renderMode === 'typeset') {
          if (!current.audience)
            throw scopeError(
              'premium_audience_missing',
              'The typeset edition is missing its audience',
            );
          const overflow = await validatePremiumTypesetPages(
            current.opening.locale,
            current.audience,
            [page],
          );
          if (overflow.length)
            throw scopeError(
              'premium_typeset_overflow',
              'Edited passage exceeds the typeset page area',
            );
          delete page.reading;
        }
      }
      if (input.leftDescription) spread.leftDescription = input.leftDescription;
      if (independent && !input.artworkInstructions && !targetSide) {
        const changeLeft =
          (left.text !== previousLeftText && left.renderMode === 'embedded_art') ||
          previousLeftDescription !== spread.leftDescription;
        const changeRight = right.text !== previousRightText && right.renderMode === 'embedded_art';
        if (changeLeft !== changeRight) targetSide = changeLeft ? 'left' : 'right';
      }
    } else {
      if (
        (input.textLayout && !['right_only', 'both_pages'].includes(input.textLayout)) ||
        (input.leftText && !narrativeText.safeParse(input.leftText).success) ||
        (input.rightText !== undefined && !narrativeText.safeParse(input.rightText).success)
      ) {
        throw scopeError('premium_correction_layout', 'Narration does not fit this edition');
      }
      applyPremiumSpreadText(spread, left, right, input, embeddedLettering);
    }
    const regenerateLettering =
      embeddedLettering &&
      ((left.text !== previousLeftText && left.renderMode !== 'typeset') ||
        (right.text !== previousRightText && right.renderMode !== 'typeset') ||
        spread.leftDescription !== previousLeftDescription);
    if (input.artworkInstructions || regenerateLettering) {
      const scene = premiumSpreadScene(spread.action);
      const action = input.artworkInstructions
        ? `${scene}\nRequested correction: ${input.artworkInstructions}`
        : scene;
      const scope = {
        storyId,
        ownerId: marker.ownerId,
        revision: input.correctionId,
        audience: marker.audience,
        opening: current.opening,
        editionLayout: current.editionLayout,
      };
      verifyPremiumAssetScope(storyId, current.reference);
      verifyPremiumAssetScope(storyId, spread.source);
      const ref = await readPremiumObject(bucket, current.reference);
      const source = await readPremiumObject(bucket, spread.source);
      const previous = independent ? source : await sharp(source).jpeg({ quality: 96 }).toBuffer();
      const previousTiles: Partial<Record<'left' | 'right', Buffer>> = {};
      if (independent) {
        for (const [side, page] of [
          ['left', left],
          ['right', right],
        ] as const) {
          if (!page.artwork) continue;
          verifyPremiumAssetScope(storyId, page.artwork);
          previousTiles[side] = await readPremiumObject(bucket, page.artwork);
        }
      }
      const schema = artworkCheckpointFor(current.editionLayout, spread.id);
      const art = await stage(bucket, prefix, spread.id, inputHash, schema, () =>
        createArtwork(
          bucket,
          prefix,
          scope,
          current.config,
          current.textConfig,
          spread.id,
          current.visualGuide,
          action,
          ref,
          embeddedLettering
            ? { ...spread, typesetBackground: current.openingDesign?.background }
            : {
                ...spread,
                textBoxes: { left: left.textBox, right: right.textBox ?? PREMIUM_TEXT_BOX },
              },
          previous,
          embeddedLettering ? { leftText: left.text, rightText: right.text } : undefined,
          independent ? { previousTiles, targetSide } : undefined,
        ),
      );
      if (left.renderMode !== 'typeset' && targetSide !== 'right')
        Object.assign(left, pageArt(art, 0, !independent));
      if (right.renderMode !== 'typeset' && targetSide !== 'left')
        Object.assign(right, pageArt(art, 1, !independent));
      if (!embeddedLettering && art.spreadTextBoxes) {
        if (art.spreadTextBoxes.left) left.textBox = art.spreadTextBoxes.left;
        right.textBox = art.spreadTextBoxes.right;
      }
      Object.assign(spread, { master: art.master, source: art.source, ...nativeFor(art) });
      current.natives[spread.id] = nativeFor(art);
    }
  }
  const revised: PremiumManifest = {
    ...current,
    previousRevision: current.revision,
    revision: input.correctionId,
    supersedes: inputHash,
  };
  await addPremiumPagePreviews(bucket, prefix, revised);
  await verifyManifestArtwork(bucket, revised);
  return {
    revision: revised.revision,
    manifest: prepareOnly
      ? await writeManifest(bucket, prefix, revised)
      : await publishManifest(bucket, prefix, revised, marker),
  };
}
