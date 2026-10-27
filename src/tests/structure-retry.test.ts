import { relocateStructureInput } from '@/services/structure-inputs.js';
import { withStructureLock } from '@/services/structure-lock.js';
const mockClient = { query: jest.fn(), release: jest.fn(), on: jest.fn(), off: jest.fn() };
jest.mock('@/db/connection.js', () => ({ acquireDatabaseClient: jest.fn(async () => mockClient) }));

describe('structure retry input recovery', () => {
  const storage = { fileExists: jest.fn(), moveFile: jest.fn(), copyFile: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('uses the same-story destination when staging was already moved', async () => {
    storage.fileExists.mockImplementation(async (path) => path === 'story/inputs/photo.jpg');
    expect(
      await relocateStructureInput(
        storage,
        'story',
        'author',
        'author/inputs/photo.jpg',
        async () => false,
      ),
    ).toBe('story/inputs/photo.jpg');
    expect(storage.moveFile).not.toHaveBeenCalled();
  });
  it('rejects missing inputs rather than returning a fabricated relocated path', async () => {
    storage.fileExists.mockResolvedValue(false);
    await expect(
      relocateStructureInput(
        storage,
        'story',
        'author',
        'author/inputs/photo.jpg',
        async () => false,
      ),
    ).rejects.toThrow('missing');
  });
  it('checks source ownership even when a same-name destination exists', async () => {
    storage.fileExists.mockResolvedValue(true);
    await expect(
      relocateStructureInput(
        storage,
        'story',
        'author',
        'other/inputs/photo.jpg',
        async () => false,
      ),
    ).rejects.toThrow('not owned');
    expect(storage.fileExists).not.toHaveBeenCalled();
  });
  it('recovers a move whose response was lost only when destination really exists', async () => {
    storage.fileExists.mockResolvedValue(true);
    storage.moveFile.mockRejectedValue(new Error('network'));
    await expect(
      relocateStructureInput(storage, 'story', 'author', 'author/inputs/a.jpg', async () => false),
    ).resolves.toBe('story/inputs/a.jpg');
  });
});

describe('structure worker fencing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockResolvedValue({ rows: [{ locked: true }] });
  });
  afterEach(() => jest.useRealTimers());
  it('keeps its lock after deadline until underlying work settles', async () => {
    jest.useFakeTimers();
    let settle!: () => void;
    let signal!: AbortSignal;
    const work = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const pending = withStructureLock(
      'story',
      (s) => {
        signal = s;
        return work;
      },
      Date.now() + 100,
    );
    const rejected = expect(pending).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(true);
    expect(mockClient.release).not.toHaveBeenCalled();
    settle();
    await rejected;
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
  it('does not enter a worker when another instance holds the lock past deadline', async () => {
    jest.useFakeTimers();
    mockClient.query.mockResolvedValue({ rows: [{ locked: false }] });
    const work = jest.fn();
    const pending = withStructureLock('story', work, Date.now() + 100);
    const rejected = expect(pending).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(200);
    await rejected;
    expect(work).not.toHaveBeenCalled();
  });
});
