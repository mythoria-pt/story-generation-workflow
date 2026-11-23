import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getStorageService } from './storage-singleton.js';
import { getEnvironment } from '@/config/environment.js';

// The asset bucket may serve public images. Encrypt all manuscript/context/token artifacts.
function key(runId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      getEnvironment().STORY_GENERATION_WORKFLOW_API_KEY,
      runId,
      'mythoria-story-text-v1',
      32,
    ),
  );
}
export function encryptCheckpoint(value: unknown, runId: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(runId), nonce);
  cipher.setAAD(Buffer.from(runId));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}
export function decryptCheckpoint<T>(buffer: Buffer, runId: string): T {
  const cipher = createDecipheriv('aes-256-gcm', key(runId), buffer.subarray(0, 12));
  cipher.setAAD(Buffer.from(runId));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8'),
  ) as T;
}
export async function saveTextCheckpoint(path: string, runId: string, value: unknown) {
  await getStorageService().uploadFile(
    path,
    encryptCheckpoint(value, runId),
    'application/octet-stream',
    { cacheControl: 'no-store' },
  );
}
export async function loadTextCheckpoint<T>(path: string, runId: string): Promise<T> {
  return decryptCheckpoint<T>(await getStorageService().downloadFileAsBuffer(path), runId);
}
