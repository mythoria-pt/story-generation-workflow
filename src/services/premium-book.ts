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
import { premiumOpeningPages } from './premium-book-opening.js';
import { buildPremiumStoryboardPrompt } from './premium-book-storyboard.js';
import {
  generatePremiumImage,
  generatePremiumText,
  getPremiumConfiguration,
  premiumTextConfig,
  reviewPremiumImage,
} from './premium-book-ai.js';
import {
  exportPremiumArtwork,
  premiumGeometry,
  PREMIUM_PRINT_PPI,
  PREMIUM_READING_PPI,
} from './premium-book-artwork.js';
import {
  applyPremiumSpreadText,
  hasPremiumMarker,
  narrativeText,
  openingPlan,
  PREMIUM_BOOK_TYPE,
  PREMIUM_FORMAT,
  PREMIUM_SPREAD_COUNT,
  PREMIUM_TEXT_BOX,
  PremiumBookError,
  premiumAsset,
  premiumAudience,
  premiumBoard,
  generatedPremiumBoard,
  premiumLeftDescription,
  premiumImageConfig,
  premiumManifest,
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
  getPremiumBucket,
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumManifest,
  readPremiumObject,
  savePremiumImage,
  savePremiumObject,
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
    spreadId: z.string().regex(/^spread-(?:[1-9]|1[0-3])$/),
    textLayout: premiumTextLayout.optional(),
    leftText: z.union([narrativeText, z.literal('')]).optional(),
    rightText: narrativeText.optional(),
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

const frozenSchema = z.object({
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
});
type FrozenBook = z.infer<typeof frozenSchema>;
const artworkSchema = z.object({
  master: premiumAsset,
  source: premiumAsset,
  printPages: z.array(premiumAsset).min(1).max(2),
  readingPages: z.array(premiumAsset).min(1).max(2),
  nativeWidth: z.number().int().positive(),
  nativeHeight: z.number().int().positive(),
  effectivePpi: z.number().positive(),
});
type Artwork = z.infer<typeof artworkSchema>;
type StoryRow = typeof stories.$inferSelect;
type Queued = Extract<PremiumMarker, { state: 'queued' }>;
type Published = Extract<PremiumMarker, { state: 'published' }>;
type Scope = { storyId: string; ownerId: string; revision: string };

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

async function freezeInput(bucket: Bucket, prefix: string, story: StoryRow, marker: Queued) {
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
  return {
    ...scope,
    audience: marker.audience,
    opening: {
      title: story.title,
      author: story.customAuthor?.trim() || author?.name?.trim() || 'Mythoria',
      locale: normalizeLocale(story.storyLanguage),
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

const textArea = `from ${Math.round(PREMIUM_TEXT_BOX.y * 100)}% to ${Math.round((PREMIUM_TEXT_BOX.y + PREMIUM_TEXT_BOX.height) * 100)}% down and from ${Math.round(PREMIUM_TEXT_BOX.x * 100)}% to ${Math.round((PREMIUM_TEXT_BOX.x + PREMIUM_TEXT_BOX.width) * 100)}% across the trimmed page`;
const squareComposition = `Use a single continuous composition. Preserve quiet, light space ${textArea}. Keep faces and essential details away from the trim.`;
const spreadComposition =
  'One uninterrupted landscape painting. The centre is ordinary background: never draw a ruled centre line, gutter, crease, fold, diptych edge or simulated binding. Keep faces, hands and essential details outside the central 10% and away from the outer edges.';
const coverComposition =
  'Envision an 8.5-inch square casewrap cover. Extend the background to every edge and allow generous quiet space at the top and bottom for separately typeset title or synopsis. Keep essential content away from the edges and binding.';
const noText =
  'Never render text, letters, numerals, logos, labels or signatures. Background must reach every edge. Preserve visual consistency with the reference illustrations.';

function artworkAssets(art: Artwork) {
  return [art.master, art.source, ...art.printPages, ...art.readingPages];
}

async function validateAssets(bucket: Bucket, storyId: string, assets: PremiumAsset[]) {
  for (const asset of new Map(assets.map((value) => [value.key, value])).values()) {
    verifyPremiumAssetScope(storyId, asset);
    await readPremiumObject(bucket, asset);
  }
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
  spread?: { textLayout?: PremiumTextLayout | undefined; leftDescription?: string | undefined },
  priorImage?: Buffer,
): Promise<Artwork> {
  const facing = phase.startsWith('spread-');
  const leftDescription = spread?.textLayout === 'right_only' ? spread.leftDescription : undefined;
  const quietSpace =
    spread?.textLayout === 'right_only'
      ? `On the right half reserve quiet space ${textArea} for separately typeset text. The left half is silent illustration and can use the full page.`
      : `On each half reserve quiet space ${textArea} for separately typeset text. Measure each trimmed page independently.`;
  const composition = facing
    ? `${spreadComposition} ${quietSpace}`
    : ['front', 'back'].includes(phase)
      ? coverComposition
      : squareComposition;
  const size = facing ? image.spreadSize : image.squareSize;
  const references = priorImage ? [priorImage, reference] : [reference];
  const raw = await generatePremiumImage(
    scope,
    image,
    phase,
    [
      'Illustrate a premium children’s picture book.',
      composition,
      noText,
      `Shared visual guide: ${guide}`,
      `Scene: ${action}`,
      ...(leftDescription
        ? [
            `Show these details within the left page: ${JSON.stringify(leftDescription)}. Keep the words themselves out of the art.`,
          ]
        : []),
      ...(priorImage
        ? [
            'The first reference is the complete current spread. Make the requested whole-spread correction. Preserve the overall composition and all undiscussed details.',
          ]
        : []),
    ].join('\n'),
    size,
    references,
  );
  const art = await exportPremiumArtwork(raw, size, facing);
  await reviewPremiumImage(
    scope,
    text,
    phase,
    art.readingMaster,
    guide,
    [reference],
    composition,
    leftDescription,
  );
  const source = await savePremiumImage(bucket, prefix, raw, 'png');
  const master = await savePremiumImage(bucket, prefix, art.readingMaster, 'png');
  const printPages = [];
  const readingPages = [];
  for (const page of art.printPages)
    printPages.push(await savePremiumImage(bucket, prefix, page, 'jpg'));
  for (const page of art.readingPages)
    readingPages.push(await savePremiumImage(bucket, prefix, page, 'png'));
  return {
    source,
    master,
    printPages,
    readingPages,
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
  return spread.action;
}

function pageArt(art: Artwork, index: number, facing: boolean) {
  const artwork = art.printPages[index];
  const reading = art.readingPages[index];
  const digitalCrop = premiumGeometry(PREMIUM_READING_PPI, facing).reading[index];
  const printCrop = premiumGeometry(PREMIUM_PRINT_PPI, facing).print[index];
  if (!artwork || !reading || !digitalCrop || !printCrop) {
    throw scopeError('premium_page_missing', 'Premium artwork lacks a required page');
  }
  return { artwork, reading, digitalCrop, printCrop };
}

function nativeFor({ nativeWidth, nativeHeight, effectivePpi }: Artwork) {
  return { nativeWidth, nativeHeight, effectivePpi };
}

async function publishManifest(
  bucket: Bucket,
  prefix: string,
  manifest: PremiumManifest,
  prior: Queued | Published,
) {
  const checked = premiumManifest.parse(manifest);
  const asset = await savePremiumObject(
    bucket,
    `${prefix}/manifest.json`,
    Buffer.from(JSON.stringify(checked)),
    'application/json',
  );
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
    ...Object.values(manifest.covers),
    ...manifest.spreads.flatMap((spread) => [spread.master, spread.source]),
    ...manifest.pages.flatMap((page) =>
      page.artwork && page.reading ? [page.artwork, page.reading] : [],
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
  const pages: PremiumPage[] = premiumOpeningPages(opening);
  const spreads: PremiumManifest['spreads'] = [];
  const covers: Partial<PremiumManifest['covers']> = {};
  const natives: PremiumManifest['natives'] = {};
  for (const phase of checklist.slice(2)) {
    const artwork = await getStaged(bucket, prefix, phase, inputHash, artworkSchema);
    natives[phase] = nativeFor(artwork);
    if (phase === 'front' || phase === 'back') {
      covers[phase] = pageArt(artwork, 0, false).artwork;
    } else if (phase === 'opener' || phase === 'ending') {
      pages.push({
        number: phase === 'opener' ? 5 : 32,
        kind: phase,
        text: board[phase].text,
        textBox: PREMIUM_TEXT_BOX,
        ...pageArt(artwork, 0, false),
      });
    } else {
      const index = Number(phase.split('-')[1]) - 1;
      const spread = board.spreads[index];
      if (!spread)
        throw scopeError('premium_spread_missing', 'Premium spread is missing from the storyboard');
      const leftPage = 6 + index * 2;
      spreads.push({
        id: phase,
        leftPage,
        rightPage: leftPage + 1,
        master: artwork.master,
        source: artwork.source,
        action: spread.action,
        textLayout: spread.textLayout,
        ...(spread.textLayout === 'right_only' &&
          spread.leftDescription && { leftDescription: spread.leftDescription }),
        ...nativeFor(artwork),
      });
      pages.push(
        {
          number: leftPage,
          kind: 'spread',
          spreadId: phase,
          text: spread.leftText,
          ...(spread.textLayout === 'both_pages' && { textBox: PREMIUM_TEXT_BOX }),
          ...pageArt(artwork, 0, true),
        },
        {
          number: leftPage + 1,
          kind: 'spread',
          spreadId: phase,
          text: spread.rightText,
          textBox: PREMIUM_TEXT_BOX,
          ...pageArt(artwork, 1, true),
        },
      );
    }
  }
  return premiumManifest.parse({
    version: 1,
    type: PREMIUM_BOOK_TYPE,
    storyId: book.storyId,
    ownerId: book.ownerId,
    revision: book.revision,
    format: PREMIUM_FORMAT,
    opening,
    ...(board.openingDesign && { openingDesign: board.openingDesign }),
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
  if (phase === 'storyboard') {
    await stage(bucket, prefix, phase, inputHash, premiumBoard, () =>
      generatePremiumText(
        book,
        book.text,
        phase,
        buildPremiumStoryboardPrompt(book),
        generatedPremiumBoard,
      ),
    );
  } else {
    const board = await getStaged(bucket, prefix, 'storyboard', inputHash, premiumBoard);
    if (phase === 'references') {
      await stage(bucket, prefix, phase, inputHash, premiumAsset, async () => {
        const originals = [];
        for (const asset of book.referenceImages) {
          verifyPremiumAssetScope(storyId, asset);
          originals.push(await readPremiumObject(bucket, asset));
        }
        const raw = await generatePremiumImage(
          book,
          book.image,
          phase,
          `Create a consistent visual reference sheet for a children's picture book: the recurring cast clearly separated, with the required appearance, style and palette. No lettering. Use original photos as likeness references only. Character and style guide: ${board.visualGuide}\nCharacters: ${book.characters}`,
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
      const art = await stage(bucket, prefix, phase, inputHash, artworkSchema, () =>
        createArtwork(
          bucket,
          prefix,
          book,
          book.image,
          book.text,
          phase,
          board.visualGuide,
          `${sceneFor(phase, board)}\nStyle direction: ${book.direction}`,
          ref,
          board.spreads[Number(phase.split('-')[1]) - 1],
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

export async function correctPremiumSpread(
  storyId: string,
  input: z.infer<typeof correctionRequest>,
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
  const spread = current.spreads.find((entry) => entry.id === input.spreadId);
  if (!spread) throw scopeError('premium_spread_missing', 'Premium spread does not exist');
  const left = current.pages[spread.leftPage - 1];
  const right = current.pages[spread.rightPage - 1];
  if (!left || !right)
    throw scopeError('premium_page_missing', 'Premium spread has a missing page');
  applyPremiumSpreadText(spread, left, right, input);
  if (input.artworkInstructions) {
    const instructions = input.artworkInstructions;
    const scope = { storyId, ownerId: marker.ownerId, revision: input.correctionId };
    verifyPremiumAssetScope(storyId, current.reference);
    verifyPremiumAssetScope(storyId, spread.source);
    const ref = await readPremiumObject(bucket, current.reference);
    const previous = await sharp(await readPremiumObject(bucket, spread.source))
      .jpeg({ quality: 96 })
      .toBuffer();
    const art = await stage(bucket, prefix, spread.id, inputHash, artworkSchema, () =>
      createArtwork(
        bucket,
        prefix,
        scope,
        current.config,
        current.textConfig,
        spread.id,
        current.visualGuide,
        `${spread.action}\nRequested correction: ${instructions}`,
        ref,
        spread,
        previous,
      ),
    );
    Object.assign(left, pageArt(art, 0, true));
    Object.assign(right, pageArt(art, 1, true));
    Object.assign(spread, { master: art.master, source: art.source, ...nativeFor(art) });
    current.natives[spread.id] = nativeFor(art);
  }
  const revised: PremiumManifest = {
    ...current,
    previousRevision: current.revision,
    revision: input.correctionId,
    supersedes: inputHash,
  };
  await verifyManifestArtwork(bucket, revised);
  return {
    revision: revised.revision,
    manifest: await publishManifest(bucket, prefix, revised, marker),
  };
}
