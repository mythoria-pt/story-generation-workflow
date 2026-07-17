import { desc, eq, inArray } from 'drizzle-orm';
import { logger } from '@/config/logger.js';
import { getDatabase } from '@/db/connection.js';
import { analyticsOutbox, storyGenerationRequests } from '@/db/schema/index.js';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { storyGenerationRuns } from '@/db/workflows-schema/index.js';

type TerminalRun = typeof storyGenerationRuns.$inferSelect;

const normalizeFailureCode = (message: string | null): string => {
  const normalized = message?.toLowerCase() || '';
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

  async recordTerminalRun(run: TerminalRun): Promise<boolean> {
    if (run.status !== 'completed' && run.status !== 'failed') return false;

    const [request] = await this.sharedDb
      .select()
      .from(storyGenerationRequests)
      .where(eq(storyGenerationRequests.runId, run.runId));
    if (!request) {
      logger.warn('Terminal analytics request is not present in the shared database', {
        runId: run.runId,
      });
      return false;
    }

    const endedAt = run.endedAt ? new Date(run.endedAt) : new Date();
    const startedAt = run.startedAt ? new Date(run.startedAt) : new Date(run.createdAt);
    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
    const eventName =
      run.status === 'completed' ? 'story_generation_completed' : 'story_generation_failed';

    await this.sharedDb.transaction(async (tx) => {
      if (request.clientId && request.consent?.analyticsStorage === 'granted') {
        await tx
          .insert(analyticsOutbox)
          .values({
            dedupeKey: `story:${run.runId}:${run.status}`,
            eventName,
            clientId: request.clientId,
            sessionId: request.sessionId,
            consent: request.consent,
            params: {
              story_id: run.storyId,
              run_id: run.runId,
              duration_seconds: durationSeconds,
              credits_spent: request.creditsSpent,
              ...(run.status === 'failed'
                ? {
                    failure_stage: normalizeFailureStage(run.currentStep),
                    failure_code: normalizeFailureCode(run.errorMessage),
                  }
                : {}),
            },
            occurredAt: endedAt,
          })
          .onConflictDoNothing({ target: analyticsOutbox.dedupeKey });
      }

      await tx
        .update(storyGenerationRequests)
        .set({ status: run.status, terminalAt: endedAt, updatedAt: new Date() })
        .where(eq(storyGenerationRequests.runId, run.runId));
    });
    return true;
  }

  async reconcileRecentTerminalRuns(): Promise<{ inspected: number; recorded: number }> {
    const runs = await this.workflowsDb
      .select()
      .from(storyGenerationRuns)
      .where(inArray(storyGenerationRuns.status, ['completed', 'failed']))
      .orderBy(desc(storyGenerationRuns.endedAt))
      .limit(100);

    let recorded = 0;
    for (const run of runs) {
      if (await this.recordTerminalRun(run)) recorded += 1;
    }
    return { inspected: runs.length, recorded };
  }
}

export const analyticsReconciliationService = new AnalyticsReconciliationService();
