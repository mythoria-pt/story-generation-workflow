import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { logger } from '@/config/logger.js';
import { getDatabase } from '@/db/connection.js';
import { analyticsOutbox, storyGenerationRequests } from '@/db/schema/index.js';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { storyGenerationRuns } from '@/db/workflows-schema/index.js';

type TerminalRun = typeof storyGenerationRuns.$inferSelect;
export type TerminalAnalyticsOutcome =
  | 'ignored'
  | 'recorded'
  | 'deferred_context'
  | 'duplicate'
  | 'not_eligible'
  | 'untracked';

export interface AnalyticsReconciliationResult {
  inspected: number;
  recorded: number;
  deferredContext: number;
  duplicates: number;
  notEligible: number;
  untracked: number;
}

const analyticsReference = (runId: string): string =>
  createHash('sha256').update(runId).digest('hex').slice(0, 12);

const normalizeFailureCode = (message: string | null): string => {
  const normalized = message?.toLowerCase() || '';
  if (/chapter not found|chapter_not_persisted/.test(normalized)) {
    return 'chapter_persistence_race';
  }
  if (/timeout|timed out|deadline/.test(normalized)) return 'timeout';
  if (/rate.?limit|too many requests/.test(normalized)) return 'rate_limited';
  if (/quota|resource exhausted/.test(normalized)) return 'quota_exhausted';
  if (/safety|content policy|moderation/.test(normalized)) return 'safety_blocked';
  if (/auth|credential|permission|forbidden|unauthorized/.test(normalized)) return 'auth_error';
  if (/invalid|validation|schema/.test(normalized)) return 'invalid_input';
  if (/provider|upstream|service unavailable/.test(normalized)) return 'provider_error';
  return 'unknown_failure';
};

const normalizeFailureStage = (stage: string | null): string => {
  const normalized = stage
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return normalized || 'unknown';
};

export class AnalyticsReconciliationService {
  private sharedDb = getDatabase();
  private workflowsDb = getWorkflowsDatabase();

  async recordTerminalRun(run: TerminalRun): Promise<TerminalAnalyticsOutcome> {
    if (run.status !== 'completed' && run.status !== 'failed') return 'ignored';

    const [request] = await this.sharedDb
      .select()
      .from(storyGenerationRequests)
      .where(eq(storyGenerationRequests.runId, run.runId));
    if (!request) {
      logger.info('Terminal run is not tracked for analytics', {
        runRef: analyticsReference(run.runId),
      });
      return 'untracked';
    }
    const [requestedEvent] = await this.sharedDb
      .select({
        userId: analyticsOutbox.userId,
        params: analyticsOutbox.params,
        attributionId: analyticsOutbox.attributionId,
        pageLocation: analyticsOutbox.pageLocation,
        pageReferrer: analyticsOutbox.pageReferrer,
        engagementTimeMsec: analyticsOutbox.engagementTimeMsec,
      })
      .from(analyticsOutbox)
      .where(eq(analyticsOutbox.dedupeKey, `story:${run.runId}:requested`));

    const endedAt = run.endedAt ? new Date(run.endedAt) : new Date();
    const startedAt = run.startedAt ? new Date(run.startedAt) : new Date(run.createdAt);
    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
    const eventName =
      run.status === 'completed' ? 'story_generation_completed' : 'story_generation_failed';
    const failureStage = run.failureStage || normalizeFailureStage(run.currentStep);
    const failureCode = run.failureCode || normalizeFailureCode(run.errorMessage);
    const runRef = analyticsReference(run.runId);

    if (run.status === 'failed' && failureCode === 'unknown_failure') {
      logger.error('Unknown terminal analytics failure classification', {
        operationalAlert: true,
        runRef,
        failureStage,
        failureCode,
      });
    }

    let outcome: TerminalAnalyticsOutcome = 'not_eligible';
    await this.sharedDb.transaction(async (tx) => {
      if (request.consent?.analyticsStorage === 'granted') {
        const [inserted] = await tx
          .insert(analyticsOutbox)
          .values({
            dedupeKey: `${eventName}:${run.runId}`,
            eventName,
            authorId: request.authorId,
            attributionId: request.attributionId || requestedEvent?.attributionId,
            clientId: request.clientId,
            userId: requestedEvent?.userId,
            sessionId: request.sessionId,
            consent: request.consent,
            pageLocation: requestedEvent?.pageLocation,
            pageReferrer: requestedEvent?.pageReferrer,
            engagementTimeMsec: requestedEvent?.engagementTimeMsec || 100,
            params: {
              story_id: run.storyId,
              run_ref: runRef,
              duration_seconds: durationSeconds,
              credits_spent: request.creditsSpent,
              ...(typeof requestedEvent?.params?.primary_intent === 'string'
                ? { primary_intent: requestedEvent.params.primary_intent }
                : {}),
              ...(run.status === 'failed'
                ? {
                    failure_stage: failureStage,
                    failure_code: failureCode,
                  }
                : {}),
            },
            occurredAt: endedAt,
          })
          .onConflictDoNothing({ target: analyticsOutbox.dedupeKey })
          .returning({ outboxId: analyticsOutbox.outboxId });
        outcome = inserted ? (request.clientId ? 'recorded' : 'deferred_context') : 'duplicate';
      }

      await tx
        .update(storyGenerationRequests)
        .set({ status: run.status, terminalAt: endedAt, updatedAt: new Date() })
        .where(eq(storyGenerationRequests.runId, run.runId));
    });
    logger.info('Terminal analytics reconciliation outcome', {
      runRef,
      eventName,
      outcome,
    });
    return outcome;
  }

  async reconcileRecentTerminalRuns(): Promise<AnalyticsReconciliationResult> {
    const requests = await this.sharedDb
      .select({ runId: storyGenerationRequests.runId })
      .from(storyGenerationRequests)
      .where(
        and(
          eq(storyGenerationRequests.status, 'published'),
          isNull(storyGenerationRequests.terminalAt),
        ),
      )
      .orderBy(asc(storyGenerationRequests.createdAt))
      .limit(100);

    if (requests.length === 0) {
      return {
        inspected: 0,
        recorded: 0,
        deferredContext: 0,
        duplicates: 0,
        notEligible: 0,
        untracked: 0,
      };
    }

    const runs = await this.workflowsDb
      .select()
      .from(storyGenerationRuns)
      .where(
        and(
          inArray(
            storyGenerationRuns.runId,
            requests.map((request) => request.runId),
          ),
          inArray(storyGenerationRuns.status, ['completed', 'failed']),
        ),
      );

    const result: AnalyticsReconciliationResult = {
      inspected: requests.length,
      recorded: 0,
      deferredContext: 0,
      duplicates: 0,
      notEligible: 0,
      untracked: 0,
    };
    for (const run of runs) {
      const outcome = await this.recordTerminalRun(run);
      if (outcome === 'recorded') result.recorded += 1;
      if (outcome === 'deferred_context') result.deferredContext += 1;
      if (outcome === 'duplicate') result.duplicates += 1;
      if (outcome === 'not_eligible') result.notEligible += 1;
      if (outcome === 'untracked') result.untracked += 1;
    }
    return result;
  }
}

export const analyticsReconciliationService = new AnalyticsReconciliationService();
