import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GoogleCloudWorkflowsAdapter } from '@/adapters/google-cloud/workflows-adapter.js';
import { logger } from '@/config/logger.js';
import { getWorkflowsDatabase, storyGenerationRuns } from '@/db/workflows-db.js';
import { readPremiumMarker } from './premium-book-contract.js';
import {
  adminPremiumPrintRenderer,
  findPremiumSelfPrintFunding,
  getVerifiedPremiumPrintPackage,
  premiumSelfPrintSource,
  renderPremiumPrintPackage,
  type PremiumPrintPart,
  type PremiumSelfPrintSource,
} from './premium-self-print.js';
import { RunsService } from './runs.js';
import { StoryService } from './story.js';

type Run = typeof storyGenerationRuns.$inferSelect;
type Edition = { storyId: string; revision: string };
type ReadyPackage = NonNullable<Awaited<ReturnType<typeof getVerifiedPremiumPrintPackage>>>;
const staffDispatch = z.object({
  source: premiumSelfPrintSource,
  attemptId: z.uuid(),
  renderer: z.literal(adminPremiumPrintRenderer),
});
const metadata = z.object({ premiumAdminPrint: staffDispatch });
const selfPrintMetadata = z.object({ premiumSelfPrint: premiumSelfPrintSource });
const workflow = new GoogleCloudWorkflowsAdapter();
const runs = new RunsService();
const stories = new StoryService();
const queuedLeaseMs = 2 * 60 * 1000;
// Cloud Run permits a 60-minute request. Keep the running lease through that window.
const runningLeaseMs = 62 * 60 * 1000;

export class PremiumAdminPrintError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function currentSource({ storyId, revision }: Edition): Promise<PremiumSelfPrintSource> {
  const story = await stories.getStory(storyId);
  const marker = readPremiumMarker(story?.features);
  if (
    story?.status !== 'published' ||
    marker?.state !== 'published' ||
    marker.revision !== revision
  ) {
    throw new PremiumAdminPrintError(404, 'Published edition not found');
  }
  return { ownerId: story.authorId, revision, manifest: marker.manifest, generateCMYK: true };
}

function staffRunId(storyId: string, source: PremiumSelfPrintSource) {
  const { key, generation, sha256, bytes } = source.manifest;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'premium-admin-print',
        adminPremiumPrintRenderer,
        storyId,
        source.revision,
        key,
        generation,
        sha256,
        bytes,
      ]),
    )
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function readStaffSource(run: Run, storyId: string, source: PremiumSelfPrintSource) {
  const result = metadata.safeParse(run.metadata);
  if (
    run.storyId !== storyId ||
    !result.success ||
    !isDeepStrictEqual(result.data.premiumAdminPrint.source, source)
  ) {
    throw new PremiumAdminPrintError(409, 'The export no longer matches the published edition');
  }
  return result.data.premiumAdminPrint;
}

async function eligibleSelfPrint(run: Run, storyId: string, source: PremiumSelfPrintSource) {
  if (run.storyId !== storyId || run.status !== 'completed') return null;
  const parsed = selfPrintMetadata.safeParse(run.metadata);
  if (!parsed.success) return null;
  const { premiumSelfPrint: stored } = parsed.data;
  if (!isDeepStrictEqual(stored, { ...source, generateCMYK: stored.generateCMYK })) return null;
  if (!(await findPremiumSelfPrintFunding(storyId, run.runId, stored, true))) return null;
  return getVerifiedPremiumPrintPackage(storyId, run.runId, stored, 'self-print');
}

async function latestSelfPrint(storyId: string, source: PremiumSelfPrintSource) {
  const completed = await getWorkflowsDatabase()
    .select()
    .from(storyGenerationRuns)
    .where(
      and(
        eq(storyGenerationRuns.storyId, storyId),
        eq(storyGenerationRuns.status, 'completed'),
        sql`${storyGenerationRuns.metadata}->'premiumSelfPrint'->>'revision' = ${source.revision}`,
      ),
    )
    .orderBy(desc(storyGenerationRuns.endedAt), desc(storyGenerationRuns.runId));
  let rgbOnly: { runId: string; pack: ReadyPackage } | undefined;
  for (const run of completed) {
    const pack = await eligibleSelfPrint(run, storyId, source);
    if (!pack) continue;
    const result = { runId: run.runId, pack };
    if (pack.parts.length === 4) return result;
    rgbOnly ??= result;
  }
  return rgbOnly ?? null;
}

function ready(runId: string, source: 'admin' | 'self-print', pack: ReadyPackage) {
  return { status: 'ready' as const, runId, source, parts: pack.parts };
}

function activeStaffStatus(run: Run) {
  const elapsed = Date.now() - Date.parse(run.updatedAt);
  if (run.status === 'queued' && elapsed < queuedLeaseMs) return 'queued' as const;
  if (run.status === 'running' && elapsed < runningLeaseMs) return 'running' as const;
  return 'failed' as const;
}

async function matchingStaffPackage(run: Run, storyId: string, source: PremiumSelfPrintSource) {
  const { attemptId } = readStaffSource(run, storyId, source);
  return run.status === 'completed'
    ? getVerifiedPremiumPrintPackage(storyId, attemptId, source, 'admin')
    : null;
}

export async function getAdminPremiumPrintStatus(edition: Edition, generate = false) {
  const { storyId } = edition;
  const source = await currentSource(edition);
  const runId = staffRunId(storyId, source);
  const run = await runs.getRun(runId);
  if (run) {
    const pack = await matchingStaffPackage(run, storyId, source);
    if (pack) return ready(runId, 'admin', pack);
    const status = activeStaffStatus(run);
    if (status !== 'failed') return { status, runId };
  }
  const existing = await latestSelfPrint(storyId, source);
  if (existing && (!generate || existing.pack.parts.length === 4)) {
    return ready(existing.runId, 'self-print', existing.pack);
  }
  if (!generate) return run ? { status: 'failed' as const, runId } : { status: 'missing' as const };

  const attemptId = randomUUID();
  const runMetadata = {
    serviceCode: 'printGeneration',
    origin: 'admin',
    premiumAdminPrint: { source, attemptId, renderer: adminPremiumPrintRenderer },
  };
  if (run) {
    const [claimed] = await getWorkflowsDatabase()
      .update(storyGenerationRuns)
      .set({
        status: 'queued',
        currentStep: null,
        metadata: runMetadata,
        gcpWorkflowExecution: null,
        startedAt: null,
        endedAt: null,
        failureStage: null,
        failureCode: null,
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(storyGenerationRuns.runId, runId),
          eq(storyGenerationRuns.storyId, storyId),
          eq(storyGenerationRuns.updatedAt, run.updatedAt),
          eq(storyGenerationRuns.status, run.status),
        ),
      )
      .returning({ runId: storyGenerationRuns.runId });
    if (!claimed) return getAdminPremiumPrintStatus(edition);
  } else {
    const { reserved } = await runs.reserveRun(storyId, runId, runMetadata);
    if (!reserved) return getAdminPremiumPrintStatus(edition);
  }

  try {
    const payload = Buffer.from(
      JSON.stringify({ storyId, revision: source.revision, runId, adminPrintAttempt: attemptId }),
    ).toString('base64');
    const execution = await workflow.executeWorkflow('print-generation', {
      data: { message: { data: payload } },
    });
    if (!execution) throw new Error('The export execution was not confirmed');
  } catch (error) {
    // Leave an ambiguous dispatch queued. The execution can still claim it during the lease.
    logger.warn('Premium Admin print dispatch could not be confirmed', {
      storyId,
      runId,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
  }
  return { status: 'queued' as const, runId };
}

export async function signAdminPremiumPrint(
  edition: Edition,
  runId: string,
  part: PremiumPrintPart,
) {
  const { storyId } = edition;
  const source = await currentSource(edition);
  const run = await runs.getRun(runId);
  if (!run || run.storyId !== storyId) return null;
  const pack =
    runId === staffRunId(storyId, source)
      ? await matchingStaffPackage(run, storyId, source)
      : await eligibleSelfPrint(run, storyId, source);
  if (!pack || !isDeepStrictEqual(await currentSource(edition), source)) return null;
  return pack.sign(part);
}

export async function runAdminPremiumPrint(
  edition: Edition,
  runId: string,
  attemptId: string,
  executionId: string,
) {
  const { storyId } = edition;
  const run = await runs.getRun(runId);
  const data = metadata.safeParse(run?.metadata);
  if (
    !run ||
    run.storyId !== storyId ||
    !data.success ||
    data.data.premiumAdminPrint.attemptId !== attemptId ||
    data.data.premiumAdminPrint.source.revision !== edition.revision
  ) {
    throw new PremiumAdminPrintError(409, 'The export attempt is no longer current');
  }
  const { source } = data.data.premiumAdminPrint;
  const db = getWorkflowsDatabase();
  const attempt = and(
    eq(storyGenerationRuns.runId, runId),
    eq(storyGenerationRuns.storyId, storyId),
    sql`${storyGenerationRuns.metadata}->'premiumAdminPrint'->>'attemptId' = ${attemptId}`,
  );
  const now = new Date().toISOString();
  const [claimed] = await db
    .update(storyGenerationRuns)
    .set({
      status: 'running',
      currentStep: 'generate_print_pdfs',
      gcpWorkflowExecution: executionId,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(attempt, eq(storyGenerationRuns.status, 'queued')))
    .returning({ runId: storyGenerationRuns.runId });
  if (!claimed) return;

  try {
    async function verifyCurrentEdition() {
      if (
        !isDeepStrictEqual(await currentSource(edition), source) ||
        staffRunId(storyId, source) !== runId
      ) {
        throw new PremiumAdminPrintError(409, 'The published edition changed');
      }
    }
    await verifyCurrentEdition();
    await renderPremiumPrintPackage(storyId, attemptId, source, 'admin');
    await verifyCurrentEdition();
    await runs.updateRun(runId, {
      status: 'completed',
      currentStep: 'completed',
      expectedWorkflowExecution: executionId,
      metadata: { printQaStatus: 'passed' },
    });
  } catch (error) {
    await runs.updateRun(runId, {
      status: 'failed',
      expectedWorkflowExecution: executionId,
      failureStage: 'generate_print_pdfs',
      errorMessage:
        error instanceof PremiumAdminPrintError ? error.message : 'Premium PDF generation failed',
    });
    throw error;
  }
}

export async function markAdminPremiumPrintWorkerLost(
  edition: Edition,
  runId: string,
  attemptId: string,
  executionId: string,
) {
  const now = new Date().toISOString();
  await getWorkflowsDatabase()
    .update(storyGenerationRuns)
    .set({
      status: 'failed',
      currentStep: 'generate_print_pdfs',
      failureStage: 'generate_print_pdfs',
      failureCode: 'export_worker_lost',
      errorMessage: 'The PDF worker did not confirm completion',
      gcpWorkflowExecution: executionId,
      updatedAt: now,
      endedAt: now,
    })
    .where(
      and(
        eq(storyGenerationRuns.runId, runId),
        eq(storyGenerationRuns.storyId, edition.storyId),
        sql`${storyGenerationRuns.metadata}->'premiumAdminPrint'->>'attemptId' = ${attemptId}`,
        sql`${storyGenerationRuns.metadata}->'premiumAdminPrint'->'source'->>'revision' = ${edition.revision}`,
        or(
          and(
            eq(storyGenerationRuns.status, 'queued'),
            isNull(storyGenerationRuns.gcpWorkflowExecution),
          ),
          and(
            eq(storyGenerationRuns.status, 'running'),
            eq(storyGenerationRuns.gcpWorkflowExecution, executionId),
          ),
        ),
      ),
    );
}
