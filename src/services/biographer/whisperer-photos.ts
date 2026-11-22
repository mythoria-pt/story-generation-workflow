import { sql } from 'drizzle-orm';
import { getDatabase } from '@/db/connection.js';
import { StorageService } from '@/services/storage.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const privatePhotoName = new RegExp(`^whisperer-(${uuid})-${uuid}\\.(jpg|png|webp)$`);
const privateInputPath = /^[^/]+\/inputs\/whisperer-/;

export function isWhispererPrivateInput(path: string): boolean {
  return privateInputPath.test(path);
}

export function isScopedWhispererPhoto(
  storyId: string,
  path: string,
  structureRequestId?: string,
): boolean {
  const prefix = `${storyId}/inputs/`;
  if (!path.startsWith(prefix)) return false;
  const match = privatePhotoName.exec(path.slice(prefix.length));
  return Boolean(match && (!structureRequestId || match[1] === structureRequestId));
}

export function getWhispererPrivateStorage() {
  const bucket = process.env.BIOGRAPHER_STORAGE_BUCKET?.trim();
  if (!bucket || bucket === process.env.STORAGE_BUCKET_NAME?.trim())
    throw new Error('Whisperer private storage is not configured');
  return { bucket, storage: new StorageService(bucket) };
}

// Share the WebApp's draft lock so an access completes before permanent
// deletion closes the draft, or skips after it closes.
export async function withWhispererDraftAccess<T>(
  authorId: string,
  storyId: string,
  action: () => Promise<T>,
) {
  return getDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`story-whisperer:${authorId.toLowerCase()}:${storyId.toLowerCase()}`}))`,
    );
    const active = await tx.execute(sql`
      select 1 from stories
      where story_id = ${storyId} and author_id = ${authorId}
        and not exists (
          select 1 from story_whisperer_deleted_drafts
          where draft_id = ${storyId} and author_id = ${authorId}
        )
    `);
    if (active.rows.length) return action();
    return undefined;
  });
}
