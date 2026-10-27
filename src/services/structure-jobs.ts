import { STRUCTURE_DEADLINE_MS } from './structure-lock.js';
import { createHash } from 'crypto';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { structureJobs } from '@/db/workflows-schema/structure-jobs.js';
import type { Job } from '@/services/job-manager.js';
import { generateStoryStructure, type GenerateStoryStructureParams } from './story-structure.js';
import { logger } from '@/config/logger.js';

export class StructureRequestConflict extends Error {}

export async function claimStructureJob(
  id: string,
  params: GenerateStoryStructureParams,
  estimatedDuration: number,
): Promise<{ id: string; created: boolean }> {
  const db = getWorkflowsDatabase();
  const inputHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
  const created = await db
    .insert(structureJobs)
    .values({
      id,
      storyId: params.storyId,
      inputHash,
      estimatedDuration,
      expiresAt: new Date(Date.now() + STRUCTURE_DEADLINE_MS),
    })
    .onConflictDoNothing({ target: structureJobs.id })
    .returning({ id: structureJobs.id });
  if (created.length) return { id, created: true };
  const [existing] = await db.select().from(structureJobs).where(eq(structureJobs.id, id));
  if (!existing || existing.storyId !== params.storyId || existing.inputHash !== inputHash) {
    throw new StructureRequestConflict('Structure request identity conflicts with existing input');
  }
  return { id, created: false };
}

export async function getDurableStructureJob(id: string): Promise<Job | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  try {
    return await readDurableStructureJob(id);
  } catch (error) {
    const dbError = error as { code?: string; cause?: { code?: string } };
    // Legacy jobs keep their original not-found behavior before the additive migration.
    if (dbError.code === '42P01' || dbError.cause?.code === '42P01') return undefined;
    throw error;
  }
}

async function readDurableStructureJob(id: string): Promise<Job | undefined> {
  const db = getWorkflowsDatabase();
  await db
    .update(structureJobs)
    .set({ status: 'failed', error: 'Story structuring timed out', updatedAt: new Date() })
    .where(
      and(
        eq(structureJobs.id, id),
        inArray(structureJobs.status, ['pending', 'processing']),
        lte(structureJobs.expiresAt, new Date()),
      ),
    );
  const [row] = await db.select().from(structureJobs).where(eq(structureJobs.id, id));
  if (!row) return undefined;
  return {
    id: row.id,
    type: 'story_structure',
    status: row.status as Job['status'],
    progress: row.status === 'completed' ? 100 : 0,
    startTime: row.startedAt,
    estimatedDuration: row.estimatedDuration,
    metadata: { storyId: row.storyId, operationType: 'story_structure' },
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export async function runDurableStructureJob(
  id: string,
  params: GenerateStoryStructureParams,
): Promise<void> {
  const db = getWorkflowsDatabase();
  const [row] = await db
    .update(structureJobs)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(
      and(
        eq(structureJobs.id, id),
        eq(structureJobs.status, 'pending'),
        gt(structureJobs.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) return;
  try {
    const result = await generateStoryStructure({ ...params, deadlineAt: row.expiresAt.getTime() });
    await db
      .update(structureJobs)
      .set({ status: 'completed', result, updatedAt: new Date() })
      .where(
        and(
          eq(structureJobs.id, id),
          eq(structureJobs.status, 'processing'),
          gt(structureJobs.expiresAt, new Date()),
        ),
      );
  } catch (error) {
    logger.error('Durable structure job failed', {
      jobId: id,
      storyId: params.storyId,
      error: error instanceof Error ? error.message : String(error),
    });
    await db
      .update(structureJobs)
      .set({ status: 'failed', error: 'Story structuring failed', updatedAt: new Date() })
      .where(eq(structureJobs.id, id));
  }
}
