/**
 * Prompt Debug Persistence
 *
 * Best-effort, opt-in persistence of the fully-rendered prompts that are sent to
 * the AI for story generation. When enabled, the rendered system + user prompt and
 * a JSON sidecar of the interpolated variables are written to
 * `{storyId}/prompts/{label}.txt` and `{label}.json` in the generated-stories bucket.
 *
 * This gives developers/admins visibility into exactly what was sent for a given
 * story, making it easy to spot when author-provided details are dropped before
 * reaching the model. It is gated behind the DEBUG_PERSIST_PROMPTS env flag and is
 * OFF by default. It must NEVER interfere with generation: all failures are swallowed.
 */
import { logger } from '@/config/logger.js';
import { getStorageService } from '@/services/storage-singleton.js';

export type PromptDebugKind = 'outline' | 'chapter' | 'image';

export interface PersistPromptDebugArgs {
  storyId: string;
  runId?: string | undefined;
  kind: PromptDebugKind;
  /** File-name-safe label, e.g. 'outline', 'text_chapter_3', 'image_front_cover'. */
  label: string;
  systemInstruction?: string | undefined;
  userPrompt: string;
  /** Interpolated variables / context to record alongside the rendered prompt. */
  metadata?: Record<string, unknown> | undefined;
}

/** Whether debug prompt persistence is enabled (read fresh so it can be toggled per-deploy). */
export function isPromptDebugEnabled(): boolean {
  return process.env.DEBUG_PERSIST_PROMPTS === 'true';
}

const SAFE_LABEL = /[^a-zA-Z0-9._-]/g;

/**
 * Persist a rendered prompt + sidecar to GCS. No-op unless DEBUG_PERSIST_PROMPTS=true.
 * Best-effort: logs and swallows any error so it can never break generation.
 */
export async function persistPromptDebug(args: PersistPromptDebugArgs): Promise<void> {
  if (!isPromptDebugEnabled()) return;

  const label = args.label.replace(SAFE_LABEL, '_');
  const base = `${args.storyId}/prompts`;

  try {
    const storage = getStorageService();

    const renderedSections: string[] = [];
    if (args.systemInstruction) {
      renderedSections.push(`=== SYSTEM ===\n${args.systemInstruction}`);
    }
    renderedSections.push(`=== USER ===\n${args.userPrompt}`);
    const rendered = renderedSections.join('\n\n');

    const sidecar = {
      storyId: args.storyId,
      runId: args.runId ?? null,
      kind: args.kind,
      label,
      createdAt: new Date().toISOString(),
      systemInstructionLength: args.systemInstruction?.length ?? 0,
      userPromptLength: args.userPrompt.length,
      metadata: args.metadata ?? {},
    };

    await Promise.all([
      storage.uploadFile(
        `${base}/${label}.txt`,
        Buffer.from(rendered, 'utf8'),
        'text/plain; charset=utf-8',
      ),
      storage.uploadFile(
        `${base}/${label}.json`,
        Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8'),
        'application/json',
      ),
    ]);

    logger.info('Persisted debug prompt', {
      storyId: args.storyId,
      runId: args.runId,
      kind: args.kind,
      label,
    });
  } catch (e) {
    logger.warn('Failed to persist debug prompt', {
      storyId: args.storyId,
      runId: args.runId,
      kind: args.kind,
      label,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
