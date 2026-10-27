import { sql } from 'drizzle-orm';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';

export class StoryGuideQuotaError extends Error {}

export async function consumeStoryGuideQuota(
  authorId: string,
  guideSessionId: string,
  now = new Date(),
): Promise<void> {
  const counters = [
    { key: `author:${authorId}:${now.toISOString().slice(0, 10)}`, limit: 30 },
    { key: `journey:${authorId}:${guideSessionId}`, limit: 9 },
  ];
  await getWorkflowsDatabase().transaction(async (tx) => {
    // Stable ordering and one transaction prevent partial debits/deadlocks across instances.
    for (const counter of counters) {
      const result = await tx.execute(sql`
        INSERT INTO story_guide_quota (key, used, updated_at) VALUES (${counter.key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET used = story_guide_quota.used + 1, updated_at = now()
        WHERE story_guide_quota.used < ${counter.limit}
        RETURNING used
      `);
      if (result.rows.length === 0) throw new StoryGuideQuotaError('Story guide quota reached');
    }
  });
}
