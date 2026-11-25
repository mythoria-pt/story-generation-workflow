import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '@/config/logger.js';
import { getDatabase } from '@/db/connection.js';
import { stories } from '@/db/schema/index.js';
import { apiKeyAuth } from '@/middleware/apiKeyAuth.js';
import { analyticsReconciliationService } from '@/services/analytics.js';
import {
  premiumAudiobookPrefix,
  premiumAudioTrack,
  premiumNarrationPages,
} from '@/services/premium-audiobook.js';
import {
  PremiumBookError,
  premiumMarker,
  readPremiumMarker,
  type PremiumAsset,
} from '@/services/premium-book-contract.js';
import {
  getPremiumBucket,
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumManifest,
  readPremiumObject,
  savePremiumObject,
  stagePremiumCheckpoint,
  withPremiumLease,
} from '@/services/premium-book-storage.js';
import { RunStoryConflictError, RunsService } from '@/services/runs.js';
import { StoryService } from '@/services/story.js';
import { TTSService } from '@/services/tts.js';
import { getTTSHttpError } from '@/services/tts-errors.js';

export const premiumAudiobookRouter = Router();
const runs = new RunsService();
const storiesService = new StoryService();
const tts = new TTSService();
const inputSchema = z.object({
  storyId: z.uuid(),
  revision: z.uuid(),
  runId: z.uuid(),
  executionId: z.string().min(1).max(255),
});
const pageInput = z.object({
  pageNumber: z.number().int().min(5).max(32),
  voice: z.string().max(64).optional(),
  includeBackgroundMusic: z.boolean().optional(),
});

function unavailable() {
  return new PremiumBookError(
    409,
    'premium_audiobook_edition_unavailable',
    'The requested edition is not published',
  );
}

function matchesAudiobookRun(metadata: unknown, revision: string) {
  const scope = z.object({
    actionType: z.literal('audiobook_generation'),
    premiumRevision: z.literal(revision),
  });
  return scope.safeParse(metadata).success;
}

premiumAudiobookRouter.get('/:storyId/:runId/:trackIndex', apiKeyAuth, async (req, res) => {
  try {
    const { storyId, runId, trackIndex } = z
      .object({
        storyId: z.uuid(),
        runId: z.uuid(),
        trackIndex: z
          .string()
          .regex(/^\d{1,2}$/)
          .transform(Number),
      })
      .parse(req.params);
    const story = await storiesService.getStory(storyId);
    const marker = readPremiumMarker(story?.features);
    const audiobook = z
      .object({
        type: z.literal('premium_children'),
        revision: z.uuid(),
        runId: z.uuid(),
        tracks: z.array(premiumAudioTrack),
      })
      .safeParse(story?.audiobookUri);
    if (
      story?.status !== 'published' ||
      marker?.state !== 'published' ||
      marker.ownerId !== story.authorId ||
      !audiobook.success ||
      audiobook.data.revision !== marker.revision ||
      audiobook.data.runId !== runId
    ) {
      res.sendStatus(404);
      return;
    }
    const track = audiobook.data.tracks[trackIndex];
    const prefix = premiumAudiobookPrefix(storyId, marker.revision, runId);
    if (
      !track ||
      track.audio.key !== `${prefix}/page-${track.pageNumber}-${track.audio.sha256}.mp3`
    ) {
      res.sendStatus(404);
      return;
    }
    const audio = await readPremiumObject(await getPremiumBucket(), track.audio);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.type('audio/mpeg');
    const ranges = req.range(audio.length, { combine: true });
    const range =
      Array.isArray(ranges) && ranges.length === 1 && ranges.type === 'bytes'
        ? ranges[0]
        : undefined;
    if (!req.headers.range) {
      res.send(audio);
    } else if (!range || typeof range !== 'object') {
      res.setHeader('Content-Range', `bytes */${audio.length}`);
      res.status(416).end();
    } else {
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${audio.length}`);
      res.status(206).send(audio.subarray(range.start, range.end + 1));
    }
  } catch (error) {
    res.sendStatus(error instanceof z.ZodError ? 400 : 503);
  }
});

premiumAudiobookRouter.post('/:operation', apiKeyAuth, async (req, res) => {
  try {
    const operation = z.enum(['plan', 'page', 'complete', 'failed']).parse(req.params.operation);
    const { storyId, revision, runId, executionId } = inputSchema.parse(req.body);
    if (runId === revision) throw unavailable();
    const metadata = { actionType: 'audiobook_generation', premiumRevision: revision };

    if (operation === 'plan') {
      const reserved = await runs.reserveRun(storyId, runId, metadata);
      if (!matchesAudiobookRun(reserved.run.metadata, revision)) {
        throw new PremiumBookError(
          409,
          'premium_audiobook_run_mismatch',
          'Run identity belongs to a different operation',
        );
      }
      const claim = await runs.claimRun(storyId, runId, executionId);
      if (
        !claim.claimed &&
        (claim.run.status !== 'running' || claim.run.gcpWorkflowExecution !== executionId)
      ) {
        res.json({ claimed: false });
        return;
      }
      await runs.updateRun(runId, {
        currentStep: 'audiobook_generation',
        expectedWorkflowExecution: executionId,
      });
      await analyticsReconciliationService.markProductRunRunning(runId);
    }

    const run = await runs.getRun(runId);
    if (
      run?.storyId !== storyId ||
      run.gcpWorkflowExecution !== executionId ||
      !matchesAudiobookRun(run.metadata, revision)
    ) {
      throw new PremiumBookError(
        409,
        'premium_audiobook_run_mismatch',
        'Audiobook execution does not own this edition',
      );
    }
    if (operation === 'failed' && run.status !== 'running') {
      res.json({ success: true });
      return;
    }
    if (operation === 'complete' && run.status === 'completed') {
      res.json({ success: true });
      return;
    }
    if (run.status !== 'running') {
      throw new PremiumBookError(
        409,
        'premium_audiobook_run_inactive',
        'Audiobook execution is inactive',
      );
    }

    const story = await storiesService.getStory(storyId);
    const rawMarker = (story?.features as { premiumBook?: unknown } | null)?.premiumBook;
    const parsedMarker = premiumMarker.safeParse(rawMarker);
    const marker = parsedMarker.success ? parsedMarker.data : null;
    const isCurrent =
      story?.status === 'published' &&
      marker?.state === 'published' &&
      marker.ownerId === story.authorId &&
      marker.revision === revision;
    const editionsMatch = and(
      eq(stories.storyId, storyId),
      eq(stories.status, 'published'),
      sql`${stories.features}->'premiumBook' = ${JSON.stringify(rawMarker ?? null)}::jsonb`,
    );
    const ownsPending = sql`${stories.audiobookUri}->>'pendingRunId' = ${runId}`;
    const saved = z.object({ runId: z.string() }).safeParse(story?.audiobookUri);
    const alreadyPublished =
      isCurrent &&
      story.audiobookStatus === 'completed' &&
      saved.success &&
      saved.data.runId === runId;

    if ((operation === 'complete' || operation === 'failed') && alreadyPublished) {
      await recordTerminal(
        await runs.updateRun(runId, {
          status: 'completed',
          currentStep: 'audiobook_completed',
          expectedWorkflowExecution: executionId,
        }),
      );
      res.json({ success: true });
      return;
    }

    if (operation === 'failed') {
      if (isCurrent) {
        await getDatabase()
          .update(stories)
          .set({
            audiobookStatus: 'failed',
            audiobookUri: sql`${stories.audiobookUri} - 'pendingRunId' - 'pendingRevision'`,
            updatedAt: new Date(),
          })
          .where(and(editionsMatch, ownsPending));
      }
      const failed = await runs.updateRun(runId, {
        status: 'failed',
        currentStep: 'audiobook_generation',
        failureStage: 'audiobook_generation',
        errorMessage: 'Premium audiobook generation failed',
        expectedWorkflowExecution: executionId,
      });
      await recordTerminal(failed);
      res.json({ success: true });
      return;
    }

    if (!isCurrent) throw unavailable();
    const bucket = await getPremiumBucket();
    const book = await readPremiumManifest(
      bucket,
      storyId,
      marker.ownerId,
      revision,
      marker.manifest,
    );
    const pages = premiumNarrationPages(book);
    if (!pages.length) throw unavailable();
    const prefix = premiumAudiobookPrefix(storyId, revision, runId);
    const checkpoint = (page: number) => `${prefix}/page-${page}.json`;

    if (operation === 'plan') {
      const [reserved] = await getDatabase()
        .update(stories)
        .set({
          audiobookStatus: 'generating',
          audiobookUri: sql`(CASE WHEN jsonb_typeof(${stories.audiobookUri}) = 'object' THEN ${stories.audiobookUri} ELSE '{}'::jsonb END) || jsonb_build_object('pendingRunId', ${runId}::text, 'pendingRevision', ${revision}::text)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            editionsMatch,
            sql`(${stories.audiobookUri}->>'pendingRevision' IS DISTINCT FROM ${revision} OR ${ownsPending})`,
          ),
        )
        .returning({ storyId: stories.storyId });
      if (!reserved)
        throw new PremiumBookError(
          409,
          'premium_audiobook_unavailable',
          'The edition changed or another narration is in progress',
        );
      res.json({ claimed: true, pageNumbers: pages.map(({ number }) => number) });
      return;
    }

    const pending = z.object({ pendingRunId: z.literal(runId) }).safeParse(story.audiobookUri);
    if (!pending.success)
      throw new PremiumBookError(
        409,
        'premium_audiobook_run_mismatch',
        'Audiobook execution does not own the pending narration',
      );

    if (operation === 'page') {
      const { pageNumber, voice, includeBackgroundMusic } = pageInput.parse(req.body);
      const page = pages.find(({ number }) => number === pageNumber);
      if (!page) {
        throw new PremiumBookError(
          422,
          'premium_audiobook_page_not_narrated',
          'This edition page has no narration',
        );
      }
      const key = checkpoint(pageNumber);
      const track = await withPremiumLease(bucket, key, () =>
        stagePremiumCheckpoint(bucket, key, premiumAudioTrack, async () => {
          let audio: PremiumAsset | undefined;
          const result = await tts.generateChapterAudioFromText(
            storyId,
            pageNumber,
            page.text,
            book.opening.title,
            voice,
            'chapter',
            {
              storyAuthor: book.opening.author,
              storyLanguage: book.opening.locale,
              dedicatoryMessage: book.opening.dedication,
              isFirstChapter: page === pages[0],
              ...(includeBackgroundMusic !== undefined && { includeBackgroundMusic }),
              async savePremiumPage(bytes) {
                audio = await savePremiumObject(
                  bucket,
                  `${prefix}/page-${pageNumber}-${premiumDigest(bytes)}.mp3`,
                  bytes,
                  'audio/mpeg',
                );
                return audio.key;
              },
            },
          );
          if (!audio) throw new Error('Missing premium audiobook storage reference');
          return { pageNumber, duration: result.duration, audio };
        }),
      );
      res.json({ success: true, pageNumber: track.pageNumber });
      return;
    }

    const tracks = await Promise.all(
      pages.map(async ({ number }) => {
        const track = await readPremiumCheckpoint(bucket, checkpoint(number), premiumAudioTrack);
        if (
          !track ||
          track.pageNumber !== number ||
          track.audio.key !== `${prefix}/page-${number}-${track.audio.sha256}.mp3`
        ) {
          throw new PremiumBookError(
            409,
            'premium_audiobook_incomplete',
            'Audiobook incomplete for the requested edition',
          );
        }
        await readPremiumObject(bucket, track.audio);
        return track;
      }),
    );
    const totalDuration = tracks.reduce((duration, track) => duration + track.duration, 0);
    const [updated] = await getDatabase()
      .update(stories)
      .set({
        audiobookStatus: 'completed',
        hasAudio: true,
        audiobookUri: { type: 'premium_children', revision, runId, tracks },
        updatedAt: new Date(),
      })
      .where(and(editionsMatch, ownsPending))
      .returning({ storyId: stories.storyId });
    if (!updated) throw unavailable();

    const completed = await runs.updateRun(runId, {
      status: 'completed',
      currentStep: 'audiobook_completed',
      expectedWorkflowExecution: executionId,
      metadata: { expectedChapters: pages.length, generatedChapters: tracks.length, totalDuration },
    });
    await recordTerminal(completed);
    res.json({ success: true, totalDuration, pagesProcessed: tracks.length });
  } catch (error) {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof RunStoryConflictError
          ? 409
          : error instanceof PremiumBookError
            ? error.status
            : getTTSHttpError(error).statusCode;
    logger.error('Premium audiobook operation failed', {
      operation: req.params.operation,
      status,
      code: error instanceof PremiumBookError ? error.code : getTTSHttpError(error).body.code,
    });
    res.status(status).json({ error: 'Premium audiobook operation failed' });
  }
});

async function recordTerminal(run: Awaited<ReturnType<RunsService['updateRun']>>) {
  try {
    await analyticsReconciliationService.recordTerminalRun(run);
  } catch {
    logger.warn('Premium audiobook terminal analytics will be repaired by reconciliation');
  }
}
