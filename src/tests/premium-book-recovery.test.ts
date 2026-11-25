import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableName, type Table } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getDatabase } from '@/db/connection.js';
import { RunsService } from '@/services/runs.js';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import { PrintService } from '@/services/print.js';
import * as premiumAi from '@/services/premium-book-ai.js';
import * as premiumArtwork from '@/services/premium-book-artwork.js';
import * as premiumMotif from '@/services/premium-book-motif.js';
import * as premiumStorage from '@/services/premium-book-storage.js';
import {
  PREMIUM_EMBEDDED_LETTERING_EDITION,
  PREMIUM_PAGE_COUNT,
  PREMIUM_TEXT_BOX,
  premiumManifest,
  premiumRevisionPrefix,
} from '@/services/premium-book-contract.js';
import {
  advancePremiumRun,
  claimPremiumResume,
  cleanPremiumTerminalDrafts,
  correctPremiumSpread,
  identifyPremiumRun,
  markPremiumTerminalFailure,
  PREMIUM_LAST_STAGE,
  resumePremiumRun,
  resolvePremiumTerminalStatus,
} from '@/services/premium-book.js';
import { premiumInvitationPage } from '@/services/premium-book-invitation.js';
import { premiumLetteredManifestFixture, premiumManifestFixture } from './fixtures/premium-book.js';
import { fixtureBucket } from './fixtures/premium-storage.js';

jest.mock('@/db/connection.js', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/runs.js', () => ({ RunsService: jest.fn() }));
jest.mock('@/adapters/google-cloud/workflows-adapter.js', () => ({
  GoogleCloudWorkflowsAdapter: jest.fn(),
}));

const fixture = premiumManifestFixture();
const { storyId, ownerId, revision: runId } = fixture;
const queued = {
  version: 1,
  type: 'premium_children',
  state: 'queued',
  revision: runId,
  ownerId,
  audience: 'children_0-2',
};

function setup(identity = { storyId, ownerId, revision: runId }) {
  const { storyId, ownerId, revision } = identity;
  const events: string[] = [];
  const storyWrites: Record<string, unknown>[] = [];
  const cast: { character: { authorId: string; name: string; type: string }; role: string }[] = [];
  const story = {
    storyId,
    authorId: ownerId,
    ownerId,
    status: 'writing',
    storyGenerationStatus: 'running',
    features: { premiumBook: { ...queued, revision, ownerId } },
  };
  const request = { storyId, ownerId, status: 'published', compensatedAt: null as Date | null };
  const run = {
    storyId,
    status: 'running',
    gcpWorkflowExecution: 'old',
    updatedAt: 'initial-timestamp',
  };
  const runMock = {
    getRun: jest.fn(async () => run),
    updateRun: jest.fn(),
    claimPremiumResume: jest.fn(async () => run),
  };
  const cloud = {
    getWorkflowExecution: jest.fn(async () => ({ status: 'running' })),
    executeWorkflow: jest.fn(async (_name: string, _argument: unknown) => 'new-execution'),
  };
  const query = (table: Table) => {
    const name = getTableName(table);
    const rows = () => {
      if (name === 'stories') return [story];
      if (name === 'story_characters') return cast;
      if (name === 'authors') return [{ name: 'Robin Winter' }];
      return [request];
    };
    const where = () =>
      Object.assign(Promise.resolve(rows()), {
        for: async () => {
          events.push(`lock ${name}`);
          return rows();
        },
        orderBy: async () => rows(),
      });
    return { where, innerJoin: () => ({ where }) };
  };
  const tx = {
    select: () => ({ from: query }),
    update: (table: Table) => ({
      set: (data: { status?: string; storyGenerationStatus?: string }) => ({
        where: async () => {
          const name = getTableName(table);
          if (name === 'stories') storyWrites.push(data);
          events.push(`write ${name}: ${data.storyGenerationStatus ?? data.status}`);
        },
      }),
    }),
  };
  (getDatabase as jest.Mock).mockReturnValue({
    ...tx,
    transaction: async (work: (database: typeof tx) => Promise<void>) => work(tx),
  });
  (RunsService as jest.Mock).mockImplementation(() => runMock);
  (GoogleCloudWorkflowsAdapter as jest.Mock).mockImplementation(() => cloud);
  return { story, request, run, runMock, cloud, events, storyWrites, cast };
}

beforeEach(async () => {
  jest.clearAllMocks();
  const capture = await sharp({
    create: { width: 840, height: 840, channels: 3, background: '#f9efd9' },
  })
    .png()
    .toBuffer();
  jest
    .spyOn(PrintService.prototype, 'renderPageImages')
    .mockImplementation(async (html) => Array.from(html.matchAll(/<section\b/g), () => capture));
});

describe('premium accepted run and recovery', () => {
  it('locks story then accepted request before the first premium provider stage', async () => {
    const { events } = setup();
    expect(await identifyPremiumRun(storyId, runId, 'old')).toMatchObject({ premium: true });
    expect(events).toEqual([
      'lock stories',
      'lock story_generation_requests',
      'write stories: running',
    ]);
  });

  it('stops when queue compensation wins the lock', async () => {
    const { request, story, events } = setup();
    const recovered = story.features;
    Object.defineProperty(story, 'features', {
      get: () =>
        events.includes('lock stories')
          ? { premiumBook: { ...queued, state: 'draft' } }
          : recovered,
    });
    request.compensatedAt = null;
    await expect(identifyPremiumRun(storyId, runId, 'old')).rejects.toMatchObject({
      code: 'premium_identity',
    });
    expect(events).toEqual(['lock stories']);
  });

  it('generates and publishes a fresh German toddler book from its accepted draft', async () => {
    const identity = { storyId: randomUUID(), ownerId: randomUUID(), revision: randomUUID() };
    const { storyId, ownerId, revision } = identity;
    const { story, storyWrites, cast } = setup(identity);
    const { bucket, objects } = fixtureBucket();
    Object.assign(story, {
      title: 'Lina und der rote Ball',
      storyLanguage: 'de-DE',
      targetAudience: 'children_0-2',
      dedicationMessage: 'Für alle kleinen Ballfänger.',
      plotDescription: 'Lina rollt ihren Ball durch den Garten.',
      createdAt: new Date('2026-11-24T11:00:00Z'),
    });
    cast.push({ character: { authorId: ownerId, name: 'Lina', type: 'human' }, role: 'main' });
    const action = 'Lina kneels in the garden with the red ball beside her.';
    const board = {
      synopsis: 'Lina und ihr Ball entdecken den Garten.',
      visualGuide: 'Large painted shapes with warm ochre and bright red.',
      front: action,
      back: action,
      opener: { text: 'Da ist der Ball!', action },
      ending: { text: 'Gute Nacht, lieber Ball.', action },
      openingDesign: { motif: 'leaf', background: '#f9efd9' },
      motifBrief: 'One simple red painted ball.',
      motifSpread: 1,
      spreads: Array.from({ length: 13 }, (_, index) => ({
        textLayout: index % 2 ? 'right_only' : 'both_pages',
        leftText: index % 2 ? '' : 'Der Ball rollt.',
        rightText: 'Lina lacht.',
        leftDescription: index % 2 ? 'Der rote Ball liegt im Gras.' : '',
        action,
      })),
    };
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const jpg = await sharp(png).jpeg().toBuffer();
    const artwork = (facing: boolean) => {
      const { width, height, print } = premiumArtwork.premiumGeometry(304, facing);
      const reading = premiumArtwork.premiumGeometry(96, facing).reading;
      return {
        source: png,
        readingMaster: png,
        printPages: print.map(() => jpg),
        readingPages: reading.map(() => png),
        nativeWidth: width,
        nativeHeight: height,
        effectivePpi: 304,
        digitalCrops: reading,
        printCrops: print,
      };
    };
    jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
    jest.spyOn(premiumAi, 'getPremiumConfiguration').mockReturnValue({
      image: { ...fixture.config, squareSize: '16x16' },
      text: fixture.textConfig,
    });
    const text = jest
      .spyOn(premiumAi, 'generatePremiumText')
      .mockImplementation(async (_scope, _config, phase, _prompt, schema) => {
        expect(phase).toBe('storyboard');
        return schema.parse(board);
      });
    const images = jest.spyOn(premiumAi, 'generatePremiumImage').mockResolvedValue(png);
    const unletteredReview = jest
      .spyOn(premiumAi, 'reviewPremiumImage')
      .mockResolvedValue(undefined);
    const letteredReview = jest
      .spyOn(premiumAi, 'reviewPremiumLetteredArtwork')
      .mockResolvedValue(undefined);
    const guideReview = jest
      .spyOn(premiumAi, 'reviewPremiumLetteredGuide')
      .mockResolvedValue(undefined);
    jest.spyOn(premiumArtwork, 'inspectPremiumOpaquePng').mockResolvedValue({
      image: sharp(png),
      width: 16,
      height: 16,
    });
    const squares = jest
      .spyOn(premiumArtwork, 'exportPremiumArtwork')
      .mockResolvedValue(artwork(false));
    jest.spyOn(premiumArtwork, 'createPremiumNativeSpreadGuides').mockResolvedValue([jpg, jpg]);
    const spreads = jest
      .spyOn(premiumArtwork, 'exportNativePremiumSpread')
      .mockResolvedValue(artwork(true));
    jest.spyOn(premiumMotif, 'selectPremiumOpeningMotif').mockResolvedValue(undefined);

    try {
      const spreadPhases = board.spreads.map((_, index) => `spread-${index + 1}`);
      const phases = [
        'storyboard',
        'references',
        'front',
        'back',
        'opener',
        ...spreadPhases,
        'ending',
        'publish',
      ];
      expect(objects.size).toBe(0);
      expect(await identifyPremiumRun(storyId, revision, 'old')).toMatchObject({ premium: true });
      for (const [index, phase] of phases.entries()) {
        expect(await advancePremiumRun(storyId, revision, index, 'old')).toEqual({
          phase,
          published: phase === 'publish',
        });
      }
      const manifestKey = `${premiumRevisionPrefix(storyId, revision)}/manifest.json`;
      const manifest = premiumManifest.parse(
        JSON.parse(objects.get(manifestKey)!.bytes.toString()),
      );
      expect(storyWrites).toContainEqual(
        expect.objectContaining({
          status: 'published',
          features: {
            premiumBook: expect.objectContaining({
              state: 'published',
              revision,
              manifest: expect.objectContaining({ key: manifestKey }),
            }),
          },
        }),
      );
      expect(text.mock.calls[0]?.[3]).toContain('For ages 0–2');
      expect(text.mock.calls[0]?.[3]).toContain('de-DE');
      expect(images.mock.calls.find((call) => call[2] === 'references')?.[3]).toContain('Lina');
      expect(unletteredReview.mock.calls.map((call) => call[2])).toEqual([
        'references',
        'front',
        'back',
      ]);
      expect(letteredReview.mock.calls.map((call) => call[2])).toEqual([
        'opener',
        ...spreadPhases,
        'ending',
      ]);
      expect(guideReview.mock.calls.map((call) => call[2])).toEqual(spreadPhases);
      expect(spreads).toHaveBeenCalledTimes(13);
      expect(squares.mock.calls.map((call) => call.slice(1))).toEqual(
        Array.from({ length: 4 }, () => [premiumArtwork.PREMIUM_NATIVE_PAGE_SIZE, false, true]),
      );
      expect(
        images.mock.calls.filter((call) => call[4] === premiumArtwork.PREMIUM_NATIVE_PAGE_SIZE),
      ).toHaveLength(30);
      expect(manifest.editionLayout).toBe(PREMIUM_EMBEDDED_LETTERING_EDITION);
      expect(manifest.format.pageCount).toBe(33);
      expect([...objects.keys()].filter((key) => key.endsWith('.pdf'))).toEqual([]);
      expect(manifest.pages.every((page) => page.reading)).toBe(true);
      for (const page of manifest.pages.filter(({ artwork }) => !artwork)) {
        expect(page.artwork).toBeUndefined();
        const preview = page.reading && objects.get(page.reading.key);
        if (!preview) throw new Error('Missing preview object in fixture');
        expect(preview.metadata.contentType).toBe('image/png');
        await expect(sharp(preview.bytes).metadata()).resolves.toMatchObject({
          width: 816,
          height: 816,
        });
      }
      expect(manifest.opening).toMatchObject({
        title: 'Lina und der rote Ball',
        author: 'Robin Winter',
        locale: 'de-DE',
      });
      expect(manifest.spreads.map((spread) => spread.textLayout)).toEqual(
        board.spreads.map((spread) => spread.textLayout),
      );
      expect(manifest.pages.slice(4, 32).map(({ text }) => text)).toEqual([
        board.opener.text,
        ...board.spreads.flatMap(({ leftText, rightText }) => [leftText, rightText]),
        board.ending.text,
      ]);
      expect(
        manifest.pages
          .slice(4, 32)
          .every(({ artwork, reading, textBox }) => artwork && reading && !textBox),
      ).toBe(true);
      expect(manifest.pages[32]).toMatchObject(premiumInvitationPage('de-DE'));
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('dispatches the accepted run without changing its identity and rejects stale resume deliveries', async () => {
    const { run, runMock, cloud, events } = setup();
    run.status = 'failed';
    expect(await resumePremiumRun(storyId, runId)).toEqual({
      storyId,
      runId,
      executionId: 'new-execution',
    });
    const call = cloud.executeWorkflow.mock.calls[0];
    const event = call?.[1] as { data: { message: { data: string } } };
    const payload = JSON.parse(Buffer.from(event.data.message.data, 'base64').toString());
    expect(payload).toEqual({
      storyId,
      runId,
      bookType: 'premium_children',
      resumeUpdatedAt: run.updatedAt,
    });
    expect(events).toEqual([]);
    expect(await claimPremiumResume(storyId, runId, run.updatedAt, 'new-execution')).toEqual({
      claimed: true,
    });
    expect(events).toEqual([
      'lock stories',
      'lock story_generation_requests',
      'write story_generation_requests: published',
      'write stories: running',
    ]);
    run.status = 'running';
    run.updatedAt = 'later-timestamp';
    run.gcpWorkflowExecution = 'new-execution';
    expect(
      await claimPremiumResume(storyId, runId, 'initial-timestamp', 'other-execution'),
    ).toEqual({ claimed: false });
    expect(runMock.claimPremiumResume).toHaveBeenCalledTimes(1);
    expect(cloud.getWorkflowExecution).not.toHaveBeenCalled();
  });

  it('prevents completion before publication and leaves a blocked run recoverable', async () => {
    const { events, run } = setup();
    await expect(resolvePremiumTerminalStatus(storyId, runId, 'completed')).rejects.toMatchObject({
      code: 'premium_unpublished',
    });
    expect(await resolvePremiumTerminalStatus(storyId, runId, 'blocked')).toBe('blocked');
    expect(events).toEqual([]);
    run.status = 'blocked';
    await markPremiumTerminalFailure(storyId, runId, 'old');
    expect(events).toEqual(['lock stories', 'write stories: failed']);
    run.status = 'running';
    run.gcpWorkflowExecution = 'new-execution';
    await markPremiumTerminalFailure(storyId, runId, 'old');
    expect(events).toEqual(['lock stories', 'write stories: failed', 'lock stories']);
  });

  it('cleans only listed drafts from a cancelled run and leaves replacements and durable objects intact', async () => {
    const { run } = setup();
    const { bucket, objects } = fixtureBucket();
    const prefix = premiumRevisionPrefix(storyId, runId);
    const otherPrefix = premiumRevisionPrefix(storyId, ownerId);
    const digest = 'a'.repeat(64);
    const firstDraft = `${prefix}/review/spread-1-${digest}.draft.jpg`;
    const replacedDraft = `${prefix}/review/spread-2-${digest}.draft.jpg`;
    const keep = [
      `${prefix}/review/spread-1-${digest}.json`,
      `${prefix}/review/example.draft.jpg`,
      `${prefix}/checkpoints/spread-1.json`,
      `${prefix}/assets/${digest}.jpg`,
      `${prefix}/manifest.json`,
      `${otherPrefix}/review/spread-1-${digest}.draft.jpg`,
    ];
    await Promise.all(
      [firstDraft, replacedDraft, ...keep].map((key) =>
        premiumStorage.savePremiumObject(bucket, key, Buffer.from('fixture bytes'), 'image/jpeg'),
      ),
    );
    const bucketMock = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
    const list = premiumStorage.listPremiumReviewDrafts;
    const listMock = jest
      .spyOn(premiumStorage, 'listPremiumReviewDrafts')
      .mockImplementation(async (...args) => {
        const snapshot = await list(...args);
        const original = snapshot.find(({ key }) => key === replacedDraft)!;
        await bucket.file(replacedDraft).save(Buffer.from('replacement'), {
          preconditionOpts: { ifGenerationMatch: original.generation },
        });
        return snapshot;
      });
    try {
      for (const status of ['running', 'failed', 'blocked']) {
        run.status = status;
        await cleanPremiumTerminalDrafts(storyId, runId, 'old');
      }
      run.status = 'cancelled';
      await cleanPremiumTerminalDrafts(storyId, runId, 'stale');
      expect(bucketMock).not.toHaveBeenCalled();
      await expect(
        premiumStorage.deletePremiumReviewDraft(bucket, firstDraft, '0'),
      ).rejects.toMatchObject({
        code: 'premium_review_draft_generation',
      });

      await cleanPremiumTerminalDrafts(storyId, runId, 'old');
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(objects.has(firstDraft)).toBe(false);
      expect(objects.get(replacedDraft)?.bytes.toString()).toBe('replacement');
      expect(keep.every((key) => objects.has(key))).toBe(true);
    } finally {
      listMock.mockRestore();
      bucketMock.mockRestore();
    }
  });

  it('checks execution identity again after listing drafts', async () => {
    const { run } = setup();
    const { bucket, objects } = fixtureBucket();
    const key = `${premiumRevisionPrefix(storyId, runId)}/review/spread-1-${'a'.repeat(64)}.draft.jpg`;
    await premiumStorage.savePremiumObject(bucket, key, Buffer.from('fixture bytes'), 'image/jpeg');
    run.status = 'completed';
    const list = premiumStorage.listPremiumReviewDrafts;
    const listMock = jest
      .spyOn(premiumStorage, 'listPremiumReviewDrafts')
      .mockImplementation(async (...args) => {
        const snapshot = await list(...args);
        run.gcpWorkflowExecution = 'successor';
        return snapshot;
      });
    const bucketMock = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
    try {
      await cleanPremiumTerminalDrafts(storyId, runId, 'old');
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(objects.has(key)).toBe(true);
    } finally {
      listMock.mockRestore();
      bucketMock.mockRestore();
    }
  });

  it('keeps rejected spread feedback private and applies it when another execution retries', async () => {
    const { run } = setup();
    const { bucket, objects } = fixtureBucket();
    const prefix = premiumRevisionPrefix(storyId, runId);
    const saveCheckpoint = (name: string, inputHash: string, result: unknown) =>
      premiumStorage.savePremiumObject(
        bucket,
        `${prefix}/checkpoints/${name}.json`,
        Buffer.from(JSON.stringify({ inputHash, result })),
        'application/json',
      );
    const { synopsis, ...opening } = fixture.opening;
    const book = {
      storyId,
      ownerId,
      revision: runId,
      audience: queued.audience,
      opening,
      direction: 'A little boat travels downstream.',
      characters: 'Inês.',
      referenceImages: [],
      image: { ...fixture.config, spreadSize: '1920x976' },
      text: fixture.textConfig,
    };
    const inputHash = premiumStorage.premiumDigest(JSON.stringify(book));
    const scene = 'Inês follows the little boat.';
    const silentLeftDescription = 'A Inês vê a pequena vela amarela.';
    const artwork = await sharp({
      create: { width: 1920, height: 976, channels: 3, background: 'beige' },
    })
      .png()
      .toBuffer();
    const centreLinePixels = await sharp(artwork).raw().toBuffer();
    for (let row = 0; row < 976; row++) {
      const start = (row * 1920 + 958) * 3;
      centreLinePixels.fill(0, start, start + 4 * 3);
    }
    const centreLineArtwork = await sharp(centreLinePixels, {
      raw: { width: 1920, height: 976, channels: 3 },
    })
      .png()
      .toBuffer();
    const referenceBytes = await sharp(artwork).resize(64).jpeg().toBuffer();
    const reference = await premiumStorage.savePremiumImage(bucket, prefix, referenceBytes, 'jpg');
    await saveCheckpoint('input', runId, book);
    await saveCheckpoint('storyboard', inputHash, {
      synopsis,
      visualGuide: fixture.visualGuide,
      front: scene,
      back: scene,
      opener: { text: 'A Inês ouviu a maré.', action: scene },
      ending: { text: 'Até amanhã, barquinho!', action: scene },
      spreads: fixture.spreads.map((spread, index) => ({
        textLayout: index === 0 ? 'right_only' : spread.textLayout,
        leftText: index === 0 ? '' : fixture.pages[spread.leftPage - 1]?.text,
        rightText: fixture.pages[spread.rightPage - 1]?.text,
        action: `${scene} Keep upper 9-29% clear on both pages.`,
        leftDescription: index === 0 ? silentLeftDescription : spread.leftDescription,
      })),
    });
    await saveCheckpoint('references', inputHash, reference);

    const initialObjects = new Set(objects.keys());
    const stageIndex = 5;
    const artworkCheckpoint = `${prefix}/checkpoints/spread-1.json`;
    const rejection = new premiumAi.PremiumArtworkReviewError(['clearTextArea', 'safeGutter']);
    const bucketMock = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
    const generate = jest
      .spyOn(premiumAi, 'generatePremiumImage')
      .mockResolvedValueOnce(artwork)
      .mockResolvedValueOnce(artwork)
      .mockResolvedValueOnce(centreLineArtwork)
      .mockResolvedValue(artwork);
    const plannedScene =
      'Eye-level panorama. Put Inês and her boat low in the left half at medium scale.';
    const plan = jest
      .spyOn(premiumAi, 'generatePremiumText')
      .mockResolvedValue({ scene: plannedScene });
    const review = jest
      .spyOn(premiumAi, 'reviewPremiumImage')
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(new premiumAi.PremiumArtworkReviewError(['clearTextArea']))
      .mockResolvedValue(undefined);
    try {
      await expect(advancePremiumRun(storyId, runId, stageIndex, 'old')).rejects.toBe(rejection);
      const addedObjects = [...objects].filter(([key]) => !initialObjects.has(key));
      expect(addedObjects).toHaveLength(2);
      const [feedbackKey, feedback] = addedObjects.find(([key]) => key.endsWith('.json'))!;
      expect(feedbackKey).toMatch(/\/review\/spread-1-[0-9a-f]{64}\.json$/u);
      const draftKey = feedbackKey.replace(/\.json$/u, '.draft.jpg');
      const firstDraft = objects.get(draftKey)!;
      expect(firstDraft.metadata).toMatchObject({
        contentType: 'image/jpeg',
        cacheControl: 'private,no-store',
        metadata: {
          sha256: premiumStorage.premiumDigest(firstDraft.bytes),
          failedChecks: 'clearTextArea,safeGutter',
        },
      });
      expect(feedback.bytes.toString()).toBe('["clearTextArea","safeGutter"]');
      expect(feedback.metadata.cacheControl).toBe('private,no-store');
      expect(objects.has(artworkCheckpoint)).toBe(false);
      expect(generate.mock.calls[0]?.[3]).not.toContain('Give particular care');
      expect(plan).not.toHaveBeenCalled();

      const olderPlanHash = premiumStorage.premiumDigest(
        JSON.stringify({
          version: 1,
          action: scene,
          layout: 'right_only',
          leftDescription: silentLeftDescription,
          guide: fixture.visualGuide,
          textBoxes: { right: PREMIUM_TEXT_BOX },
          checks: ['clearTextArea', 'safeGutter'],
        }),
      );
      const oldPlanName = `shot-plan-spread-1-${olderPlanHash}`;
      const oldPlan = { scene: 'Place the boat at 18% across the picture.' };
      await saveCheckpoint(oldPlanName, olderPlanHash, oldPlan);
      const oldPlanKey = `${prefix}/checkpoints/${oldPlanName}.json`;

      run.gcpWorkflowExecution = 'retry';
      await expect(advancePremiumRun(storyId, runId, stageIndex, 'retry')).rejects.toBe(rejection);
      expect(objects.has(artworkCheckpoint)).toBe(false);
      expect(objects.get(draftKey)?.metadata.generation).not.toEqual(
        firstDraft.metadata.generation,
      );
      expect(
        [...objects.keys()].some(
          (key) =>
            key !== oldPlanKey &&
            /\/checkpoints\/shot-plan-spread-1-[a-f0-9]{64}\.json$/u.test(key),
        ),
      ).toBe(true);
      expect(JSON.parse(objects.get(oldPlanKey)!.bytes.toString())).toEqual({
        inputHash: olderPlanHash,
        result: oldPlan,
      });
      expect(plan.mock.calls[0]?.[2]).toBe('shot-plan-spread-1');
      expect(plan.mock.calls[0]?.[3]).toContain(scene);
      expect(plan.mock.calls[0]?.[3]).toContain(silentLeftDescription);
      expect(plan.mock.calls[0]?.[3]).toContain(
        'Move faces, hands and essential objects out of the central binding area.',
      );
      expect(plan.mock.calls[0]?.[3]).toContain('Use qualitative directions such as lower left');
      expect(plan.mock.calls[0]?.[3]).toContain(
        'Omit measurements, percentages, coordinates, annotations and printing or page-layout terminology.',
      );
      expect(plan.mock.calls[0]?.[3]).not.toMatch(/\d\s*%/u);

      run.gcpWorkflowExecution = 'retry-again';
      await expect(
        advancePremiumRun(storyId, runId, stageIndex, 'retry-again'),
      ).rejects.toMatchObject({
        code: 'premium_image_join',
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledTimes(2);
      expect(objects.has(artworkCheckpoint)).toBe(false);
      expect(JSON.parse(objects.get(feedbackKey)!.bytes.toString())).toEqual([
        'clearTextArea',
        'safeGutter',
        'centreLine',
      ]);
      const latestDraft = objects.get(draftKey)!;
      expect(latestDraft.metadata.metadata).toMatchObject({ failedChecks: 'centreLine' });

      run.gcpWorkflowExecution = 'retry-final';
      await expect(advancePremiumRun(storyId, runId, stageIndex, 'retry-final')).resolves.toEqual({
        phase: 'spread-1',
        published: false,
      });
      expect(plan).toHaveBeenCalledTimes(2);
      const retryPrompt = generate.mock.calls[1]?.[3];
      expect(retryPrompt).toContain(`Scene: ${plannedScene}`);
      expect(retryPrompt).not.toContain(scene);
      expect(retryPrompt).toContain(silentLeftDescription);
      expect(generate.mock.calls[2]?.[3]).toBe(retryPrompt);
      expect(retryPrompt).not.toContain('9-29%');
      expect(retryPrompt).toContain('Use the final grayscale image only');
      expect(retryPrompt).toContain('such as a mirror frame, may cross the centre');
      expect(retryPrompt).toContain('The first image is the rejected previous draft.');
      expect(retryPrompt).toContain('Repair these findings in the previous draft');
      const generationImages = generate.mock.calls[1]![5];
      expect(generationImages).toHaveLength(3);
      expect(generationImages[0]).toEqual(firstDraft.bytes);
      expect(generationImages[1]).toEqual(referenceBytes);
      expect(await sharp(generationImages[2]!).metadata()).toMatchObject({
        width: 1920,
        height: 976,
        format: 'jpeg',
      });
      expect(review.mock.calls[1]?.[5]).toEqual([referenceBytes]);
      expect(review.mock.calls[1]?.[7]).toBe(silentLeftDescription);
      expect(retryPrompt).toContain(
        'Move faces, actions and essential objects clear of the text areas.',
      );
      expect(retryPrompt).toContain(
        'Move faces, hands and essential objects out of the central binding area.',
      );
      expect(generate.mock.calls[3]?.[5][0]).toEqual(latestDraft.bytes);
      expect(generate.mock.calls[3]?.[3]).toContain(
        'Repair these findings in the previous draft: Carry continuous scenery and even lighting across the middle.',
      );
      expect(generate.mock.calls[3]?.[3]).toContain(
        'Angle physical frames and move their hard vertical edges away from the exact centre.',
      );
      expect(objects.has(artworkCheckpoint)).toBe(true);
      expect(objects.has(draftKey)).toBe(false);
      expect(generate).toHaveBeenCalledTimes(4);
      expect(review).toHaveBeenCalledTimes(4);
      expect(review.mock.calls[3]?.[3]).toBe(review.mock.calls[2]?.[3]);
      expect(review.mock.calls[2]?.[8]?.textAreas).toHaveLength(1);
      expect(review.mock.calls[3]?.[8]?.textAreas).toHaveLength(1);
      expect(review.mock.calls[2]?.[8]?.textAreas[0]?.y).toBeCloseTo(0.102, 3);
      expect(review.mock.calls[3]?.[8]?.textAreas[0]?.y).toBeCloseTo(0.704, 3);

      const { spreadTextBoxes, ...legacyArtwork } = JSON.parse(
        objects.get(artworkCheckpoint)!.bytes.toString(),
      ).result;
      const lowerBox = { ...PREMIUM_TEXT_BOX, y: 0.71 };
      expect(spreadTextBoxes).toEqual({ right: lowerBox });
      const otherPhases = [
        'front',
        'back',
        'opener',
        'ending',
        ...fixture.spreads.slice(1).map(({ id }) => id),
      ];
      await Promise.all(
        otherPhases.map((phase) => saveCheckpoint(phase, inputHash, legacyArtwork)),
      );
      await expect(
        advancePremiumRun(storyId, runId, PREMIUM_LAST_STAGE, 'retry-final'),
      ).resolves.toEqual({
        phase: 'publish',
        published: true,
      });
      const manifest = premiumManifest.parse(
        JSON.parse(objects.get(`${prefix}/manifest.json`)!.bytes.toString()),
      );
      expect(manifest.pages[5]?.textBox).toBeUndefined();
      expect(manifest.pages[6]?.textBox).toEqual(lowerBox);
      expect(manifest.pages[7]?.textBox).toEqual(PREMIUM_TEXT_BOX);
      expect(manifest.pages[8]?.textBox).toEqual(PREMIUM_TEXT_BOX);
      expect(generate).toHaveBeenCalledTimes(4);
    } finally {
      plan.mockRestore();
      review.mockRestore();
      generate.mockRestore();
      bucketMock.mockRestore();
    }
  });

  it('reuses embedded tiles across transient and text failures and replans after repeated structural rejections', async () => {
    setup();
    const { bucket, objects } = fixtureBucket();
    const prefix = premiumRevisionPrefix(storyId, runId);
    const saveCheckpoint = (name: string, inputHash: string, result: unknown) =>
      premiumStorage.savePremiumObject(
        bucket,
        `${prefix}/checkpoints/${name}.json`,
        Buffer.from(JSON.stringify({ inputHash, result })),
        'application/json',
      );
    const { synopsis, ...opening } = fixture.opening;
    const book = {
      storyId,
      ownerId,
      revision: runId,
      audience: queued.audience,
      opening: { ...opening, locale: 'de-DE' },
      direction: 'A small hedgehog follows the moon.',
      characters: 'Ein Igel.',
      referenceImages: [],
      image: { ...fixture.config, spreadSize: '1920x976' },
      text: fixture.textConfig,
      invitation: premiumInvitationPage('de-DE'),
      editionLayout: PREMIUM_EMBEDDED_LETTERING_EDITION,
    };
    const hash = premiumStorage.premiumDigest(JSON.stringify(book));
    const action = 'A hedgehog sets out a small cup, then climbs the hill and looks at the moon.';
    const replacement =
      'From eye level, show the hedgehog on the right hillside and the cup still visible by the path on the left.';
    const leftDescription = 'Links am Weg steht der kleine Becher.';
    const rightText = 'Über den Hügel, kleiner Igel!';
    const panorama = await sharp({
      create: { width: 1920, height: 976, channels: 3, background: '#c9d9ad' },
    })
      .png()
      .toBuffer();
    const badPanorama = await sharp({
      create: { width: 1920, height: 976, channels: 3, background: '#e1b3b3' },
    })
      .png()
      .toBuffer();
    const nativeTile = await sharp({
      create: { width: 2672, height: 2672, channels: 3, background: '#c9d9ad' },
    })
      .png()
      .toBuffer();
    const reference = await premiumStorage.savePremiumImage(
      bucket,
      prefix,
      await sharp(panorama).resize(64).jpeg().toBuffer(),
      'jpg',
    );
    await saveCheckpoint('input', runId, book);
    await saveCheckpoint('references', hash, reference);
    await saveCheckpoint('storyboard', hash, {
      synopsis,
      visualGuide: 'Warm paper-cut shapes.',
      front: action,
      back: action,
      opener: { text: 'Guten Abend!', action },
      ending: { text: 'Gute Nacht!', action },
      spreads: fixture.spreads.map(() => ({
        textLayout: 'right_only',
        leftText: '',
        rightText,
        action,
        leftDescription,
      })),
    });
    const bucketMock = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
    const imageFailure = new Error('Temporary image provider problem');
    const reviewFailure = new Error('Temporary review provider problem');
    const mismatch = new premiumAi.PremiumArtworkReviewError(['exactLettering'], ['right']);
    const nearTrim = new premiumAi.PremiumArtworkReviewError(['safeLettering'], ['right'], {
      right: ['safeLettering'],
    });
    const repeated = new premiumAi.PremiumArtworkReviewError(['coherentArtwork']);
    const rejectedGuide = new premiumAi.PremiumGuideReviewError(['coherentArtwork'], replacement);
    const guideTimeout = new Error('Temporary guide-review interruption');
    let guideRequests = 0;
    let rightRequests = 0;
    const generate = jest
      .spyOn(premiumAi, 'generatePremiumImage')
      .mockImplementation(async (_, __, phase) => {
        if (phase.endsWith('-guide')) return ++guideRequests === 1 ? badPanorama : panorama;
        if (phase.endsWith('-right') && ++rightRequests === 1) throw imageFailure;
        return nativeTile;
      });
    const guideReview = jest
      .spyOn(premiumAi, 'reviewPremiumLetteredGuide')
      .mockRejectedValueOnce(guideTimeout)
      .mockRejectedValueOnce(rejectedGuide)
      .mockRejectedValueOnce(guideTimeout)
      .mockResolvedValue(undefined);
    const review = jest
      .spyOn(premiumAi, 'reviewPremiumLetteredArtwork')
      .mockRejectedValueOnce(reviewFailure)
      .mockRejectedValueOnce(mismatch)
      .mockRejectedValueOnce(nearTrim)
      .mockRejectedValueOnce(repeated)
      .mockRejectedValueOnce(repeated)
      .mockResolvedValue(undefined);
    const advance = () => advancePremiumRun(storyId, runId, 5, 'old');
    try {
      await expect(advance()).rejects.toBe(guideTimeout);
      await expect(advance()).rejects.toBe(rejectedGuide);
      expect(generate.mock.calls.map((call) => call[2])).toEqual(['spread-1-lettering-guide']);
      expect(guideReview.mock.calls.map((call) => call[3])).toEqual([badPanorama, badPanorama]);
      expect(
        [...objects.keys()].some((key) => key.includes('/checkpoints/lettering-guide-review-')),
      ).toBe(false);
      await expect(advance()).rejects.toBe(guideTimeout);
      const guidePrompts = generate.mock.calls.filter((call) => call[2].endsWith('-guide'));
      expect(generate.mock.calls).toHaveLength(2);
      expect(guidePrompts[0]?.[3]).toContain(action);
      expect(guidePrompts[1]?.[3]).toContain(replacement);
      expect(guidePrompts[1]?.[3]).not.toContain(action);
      expect(guidePrompts[1]?.[3]).toContain(leftDescription);
      expect(guideReview.mock.calls.at(-1)?.[6]).toEqual({
        action,
        leftDescription,
        previousReplacement: replacement,
      });
      await expect(advance()).rejects.toBe(imageFailure);
      const approvalKey = `${prefix}/checkpoints/lettering-guide-review-spread-1-${premiumStorage.premiumDigest(panorama)}.json`;
      expect(objects.has(approvalKey)).toBe(true);
      await expect(advance()).rejects.toBe(reviewFailure);
      await expect(advance()).rejects.toBe(mismatch);
      await expect(advance()).rejects.toBe(nearTrim);
      const artworkCheckpoint = `${prefix}/checkpoints/spread-1.json`;
      expect(objects.has(artworkCheckpoint)).toBe(false);
      expect(generate.mock.calls.map((call) => call[2]).sort()).toEqual([
        'spread-1-lettering-guide',
        'spread-1-lettering-guide',
        'spread-1-lettering-left',
        'spread-1-lettering-right',
        'spread-1-lettering-right',
        'spread-1-lettering-right',
      ]);
      expect(generate.mock.calls.at(-1)?.[3]).toContain('letter for letter');
      expect(generate.mock.calls.at(-1)?.[3]).toContain(rightText);
      await expect(advance()).rejects.toBe(repeated);
      expect(generate.mock.calls.filter((call) => call[2].endsWith('-left'))).toHaveLength(1);
      expect(generate.mock.calls.filter((call) => call[2].endsWith('-guide'))).toHaveLength(2);
      expect(generate.mock.calls.at(-1)?.[3]).toContain('Address these findings on the right page');
      expect(generate.mock.calls.at(-1)?.[3]).toContain(
        'Start the first line at least 12% down from the top trim',
      );
      await expect(advance()).rejects.toBe(repeated);
      await expect(advance()).resolves.toEqual({ phase: 'spread-1', published: false });
      expect(generate.mock.calls.filter((call) => call[2].endsWith('-guide'))).toHaveLength(4);
      expect(generate.mock.calls.filter((call) => call[2].endsWith('-left'))).toHaveLength(3);
      expect(guideReview.mock.calls.map((call) => call[3])).toEqual([
        badPanorama,
        badPanorama,
        panorama,
        panorama,
      ]);
      expect(review.mock.calls.at(-1)?.[3].pages.map(({ text }) => text)).toEqual(['', rightText]);
      const checked = objects.get(artworkCheckpoint);
      expect(JSON.parse(checked?.bytes.toString() ?? '{}').result).toMatchObject({
        letteringVerified: true,
        effectivePpi: 304,
      });
    } finally {
      guideReview.mockRestore();
      review.mockRestore();
      generate.mockRestore();
      bucketMock.mockRestore();
    }
  });

  it.each([
    [undefined, true],
    [PREMIUM_EMBEDDED_LETTERING_EDITION, true],
    [PREMIUM_EMBEDDED_LETTERING_EDITION, false],
  ] as const)(
    'uses the 33-page plan frozen for layout %s from artwork checkpoints (verified: %s)',
    async (editionLayout, verified) => {
      setup();
      const { bucket, objects } = fixtureBucket();
      const prefix = premiumRevisionPrefix(storyId, runId);
      const saveCheckpoint = (phase: string, inputHash: string, result: unknown) =>
        premiumStorage.savePremiumObject(
          bucket,
          `${prefix}/checkpoints/${phase}.json`,
          Buffer.from(JSON.stringify({ inputHash, result })),
          'application/json',
        );
      const { synopsis, ...opening } = fixture.opening;
      const book = {
        storyId,
        ownerId,
        revision: runId,
        audience: queued.audience,
        opening,
        direction: '',
        characters: '',
        referenceImages: [],
        image: fixture.config,
        text: fixture.textConfig,
        invitation: premiumInvitationPage(opening.locale),
        ...(editionLayout && { editionLayout }),
      };
      const inputHash = premiumStorage.premiumDigest(JSON.stringify(book));
      const scene = fixture.spreads[0]!.action;
      const jpeg = await premiumStorage.savePremiumImage(
        bucket,
        prefix,
        Buffer.from('print'),
        'jpg',
      );
      const png = await premiumStorage.savePremiumImage(
        bucket,
        prefix,
        Buffer.from('reader'),
        'png',
      );
      const artFor = (phase: string) => ({
        master: png,
        source: png,
        printPages: phase.startsWith('spread-') ? [jpeg, jpeg] : [jpeg],
        readingPages: phase.startsWith('spread-') ? [png, png] : [png],
        nativeWidth: phase.startsWith('spread-') ? 5244 : 2660,
        nativeHeight: 2660,
        effectivePpi: 304,
        ...(editionLayout &&
          !['front', 'back'].includes(phase) &&
          (verified || phase !== 'spread-1') && { letteringVerified: true }),
      });
      await Promise.all([
        saveCheckpoint('input', runId, book),
        saveCheckpoint('references', inputHash, jpeg),
        saveCheckpoint('storyboard', inputHash, {
          synopsis,
          visualGuide: fixture.visualGuide,
          front: scene,
          back: scene,
          opener: { text: fixture.pages[4]!.text, action: scene },
          ending: { text: fixture.pages[31]!.text, action: scene },
          spreads: fixture.spreads.map((spread) => ({
            textLayout: spread.textLayout,
            leftText: fixture.pages[spread.leftPage - 1]!.text,
            rightText: fixture.pages[spread.rightPage - 1]!.text,
            action: spread.action,
            leftDescription: spread.leftDescription,
          })),
        }),
        ...['front', 'back', 'opener', ...fixture.spreads.map(({ id }) => id), 'ending'].map(
          (phase) => saveCheckpoint(phase, inputHash, artFor(phase)),
        ),
      ]);
      const bucketMock = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
      try {
        if (!verified) {
          await expect(
            advancePremiumRun(storyId, runId, PREMIUM_LAST_STAGE, 'old'),
          ).rejects.toMatchObject({ code: 'premium_document_invalid' });
          expect(objects.has(`${prefix}/manifest.json`)).toBe(false);
          return;
        }
        await expect(advancePremiumRun(storyId, runId, PREMIUM_LAST_STAGE, 'old')).resolves.toEqual(
          {
            phase: 'publish',
            published: true,
          },
        );
        const published = premiumManifest.parse(
          JSON.parse(objects.get(`${prefix}/manifest.json`)!.bytes.toString()),
        );
        expect(published.editionLayout).toBe(editionLayout);
        expect(published.format.pageCount).toBe(PREMIUM_PAGE_COUNT);
        expect(published.pages.at(-1)).toMatchObject(book.invitation ?? {});
        for (const page of published.pages.slice(4, 32)) {
          expect(page.text).toBe(fixture.pages[page.number - 1]!.text);
          expect(page.artwork).toEqual(jpeg);
          expect(page.reading).toEqual(png);
          expect(Boolean(page.textBox)).toBe(!editionLayout && Boolean(page.text));
        }
      } finally {
        bucketMock.mockRestore();
      }
    },
  );

  it.each([false, true])(
    'pins the exact corrected narration and spread assets (embedded lettering: %s)',
    async (embedded) => {
      const { story } = setup();
      const { bucket, objects } = fixtureBucket();
      const book = embedded ? premiumLetteredManifestFixture() : premiumManifestFixture();
      const prefix = premiumRevisionPrefix(storyId, runId);
      const source = await sharp({
        create: { width: 32, height: 32, channels: 3, background: 'beige' },
      })
        .png()
        .toBuffer();
      const originalPng = await premiumStorage.savePremiumImage(bucket, prefix, source, 'png');
      const originalJpg = await premiumStorage.savePremiumImage(
        bucket,
        prefix,
        await sharp(source).jpeg().toBuffer(),
        'jpg',
      );
      book.reference = originalJpg;
      book.covers = { front: originalJpg, back: originalJpg };
      for (const page of book.pages.slice(4, 32)) {
        page.artwork = originalJpg;
        page.reading = originalPng;
      }
      for (const spread of book.spreads) {
        spread.master = originalPng;
        spread.source = originalPng;
      }
      const original = await premiumStorage.savePremiumObject(
        bucket,
        `${prefix}/manifest.json`,
        Buffer.from(JSON.stringify(book)),
        'application/json',
      );
      story.status = 'published';
      Object.assign(story.features, {
        premiumBook: { ...queued, state: 'published', manifest: original },
      });
      const input = {
        expectedRevision: runId,
        correctionId: randomUUID(),
        spreadId: 'spread-1',
        rightText: 'O barquinho voltou para casa.',
      };
      const correctedPrefix = premiumRevisionPrefix(storyId, input.correctionId);
      const correctedPng = await premiumStorage.savePremiumImage(
        bucket,
        correctedPrefix,
        Buffer.from('corrected spread'),
        'png',
      );
      const correctedJpg = await premiumStorage.savePremiumImage(
        bucket,
        correctedPrefix,
        Buffer.from('corrected print art'),
        'jpg',
      );
      if (embedded) {
        const inputHash = premiumStorage.premiumDigest(JSON.stringify(input));
        await premiumStorage.savePremiumObject(
          bucket,
          `${correctedPrefix}/checkpoints/spread-1.json`,
          Buffer.from(
            JSON.stringify({
              inputHash,
              result: {
                master: correctedPng,
                source: correctedPng,
                printPages: [correctedJpg, correctedJpg],
                readingPages: [correctedPng, correctedPng],
                nativeWidth: 5244,
                nativeHeight: 2660,
                effectivePpi: 304,
                letteringVerified: true,
              },
            }),
          ),
          'application/json',
        );
      }
      const getBucket = jest.spyOn(premiumStorage, 'getPremiumBucket').mockResolvedValue(bucket);
      const generate = jest
        .spyOn(premiumAi, 'generatePremiumImage')
        .mockRejectedValue(new Error('provider called'));
      try {
        const prepared = await correctPremiumSpread(storyId, input, true);
        expect(story.features.premiumBook.revision).toBe(runId);
        const result = await correctPremiumSpread(storyId, input);
        expect(result.manifest).toEqual(prepared.manifest);
        const saved = premiumManifest.parse(
          JSON.parse(objects.get(result.manifest.key)!.bytes.toString()),
        );
        expect(saved.editionLayout).toEqual(book.editionLayout);
        expect(saved.previousRevision).toBe(runId);
        expect(saved.specification).toEqual(book.specification);
        expect(saved.pages[6]?.text).toBe(input.rightText);
        expect(saved.pages[5]?.artwork).toEqual(embedded ? correctedJpg : originalJpg);
        expect(saved.pages[6]?.reading).toEqual(embedded ? correctedPng : originalPng);
        expect(saved.pages[6]?.textBox).toEqual(embedded ? undefined : PREMIUM_TEXT_BOX);
        const prior = premiumManifest.parse(
          JSON.parse((await premiumStorage.readPremiumObject(bucket, original)).toString()),
        );
        expect(prior.pages[6]?.text).toBe(book.pages[6]?.text);
        expect(prior.pages[6]?.reading).toEqual(originalPng);
        expect(generate).not.toHaveBeenCalled();
      } finally {
        getBucket.mockRestore();
        generate.mockRestore();
      }
    },
  );
});
