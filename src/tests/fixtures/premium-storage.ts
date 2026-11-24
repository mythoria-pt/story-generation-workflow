import type { Bucket } from '@google-cloud/storage';

export function fixtureBucket() {
  type StoredObject = { bytes: Buffer; metadata: Record<string, unknown> };
  const objects = new Map<string, StoredObject>();
  const failingSaves = new Map<string, number>();
  let generation = 0;
  const error = (code: number) => Object.assign(new Error('fixture storage failure'), { code });
  const read = (key: string) => {
    const stored = objects.get(key);
    if (!stored) throw error(404);
    return stored;
  };
  return {
    objects,
    failNextSave: (key: string, code: number) => failingSaves.set(key, code),
    bucket: {
      file: (key: string, selection?: { generation?: string }) => ({
        getMetadata: async () => [read(key).metadata],
        download: async () => {
          const stored = read(key);
          if (selection?.generation && selection.generation !== stored.metadata.generation)
            throw error(404);
          return [stored.bytes];
        },
        save: async (
          data: Buffer | string,
          options: {
            preconditionOpts: { ifGenerationMatch: string | number };
            metadata?: { metadata?: unknown };
          },
        ) => {
          const failure = failingSaves.get(key);
          if (failure) {
            failingSaves.delete(key);
            throw error(failure);
          }
          const current = String(objects.get(key)?.metadata.generation ?? '0');
          if (current !== String(options.preconditionOpts.ifGenerationMatch)) throw error(412);
          const bytes = Buffer.from(data);
          objects.set(key, {
            bytes,
            metadata: {
              generation: String(++generation),
              size: bytes.length,
              updated: new Date().toISOString(),
              metadata: options.metadata?.metadata,
            },
          });
        },
        delete: async (options: { ifGenerationMatch: string }) => {
          if (options.ifGenerationMatch !== read(key).metadata.generation) throw error(412);
          objects.delete(key);
        },
      }),
    } as unknown as Bucket,
  };
}
