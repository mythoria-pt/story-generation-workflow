import type { QueryConfig } from 'pg';
import { acquireDatabaseClient } from '@/db/connection.js';

let activeLocks = 0;
const MAX_LOCAL_STRUCTURE_LOCKS = 4;

export const STRUCTURE_DEADLINE_MS = 5 * 60 * 1000;

/** All structure callers share this lock; never release while underlying work is still running. */
export async function withStructureLock<T>(
  storyId: string,
  work: (signal: AbortSignal) => Promise<T>,
  deadlineAt = Date.now() + STRUCTURE_DEADLINE_MS,
): Promise<T> {
  if (activeLocks >= MAX_LOCAL_STRUCTURE_LOCKS) throw new Error('Story structure capacity reached');
  activeLocks++;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Story structure deadline exceeded')),
    Math.max(0, deadlineAt - Date.now()),
  );
  const client = await acquireDatabaseClient().catch((error) => {
    clearTimeout(timer);
    activeLocks--;
    throw error;
  });
  let locked = false;
  const disconnected = () => controller.abort(new Error('Story structure lock connection lost'));
  client.on('error', disconnected);
  try {
    while (!locked) {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new Error('Story structure deadline exceeded');
      const result = await client.query({
        text: "SELECT pg_try_advisory_lock(hashtext('story_structure'), hashtext($1)) AS locked",
        values: [storyId],
        query_timeout: 5000,
      } as QueryConfig & { query_timeout: number });
      locked = result.rows[0]?.locked === true;
      if (!locked) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.signal.throwIfAborted();
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    activeLocks--;
    client.off('error', disconnected);
    try {
      if (locked)
        await client.query({
          text: "SELECT pg_advisory_unlock(hashtext('story_structure'), hashtext($1))",
          values: [storyId],
          query_timeout: 5000,
        } as QueryConfig & { query_timeout: number });
      client.release(!locked);
    } catch {
      client.release(true);
    }
  }
}
