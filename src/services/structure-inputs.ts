export interface StructureInputStorage {
  fileExists(path: string): Promise<boolean>;
  moveFile(source: string, destination: string): Promise<unknown>;
  copyFile(source: string, destination: string): Promise<unknown>;
}

/** Author-check before looking up a path, including when only its destination remains. */
export async function relocateStructureInput(
  storage: StructureInputStorage,
  storyId: string,
  authorId: string,
  source: string,
  ownsStory: (id: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const match = /^([^/]+)\/inputs\/([^/]+)$/.exec(source);
  if (!match || match[2] === '.' || match[2] === '..' || source.includes('\\'))
    throw new Error('Invalid story input path');
  const owner = match[1];
  if (!owner) throw new Error('Invalid story input owner');
  if (owner !== authorId && owner !== storyId && !(await ownsStory(owner)))
    throw new Error('Input source not owned by author');
  const destination = `${storyId}/inputs/${match[2]}`;
  if (source === destination) {
    if (!(await storage.fileExists(destination))) throw new Error('Story input missing');
    return destination;
  }
  if (await storage.fileExists(source)) {
    try {
      signal?.throwIfAborted();
      if (owner === authorId) await storage.moveFile(source, destination);
      else await storage.copyFile(source, destination);
    } catch (error) {
      // A move may have completed before a network response was lost.
      if (!(await storage.fileExists(destination))) throw error;
    }
  }
  if (!(await storage.fileExists(destination)))
    throw new Error('Story input missing at source and destination');
  return destination;
}
