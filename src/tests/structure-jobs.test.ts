import { createHash } from 'crypto';
import {
  claimStructureJob,
  getDurableStructureJob,
  StructureRequestConflict,
} from '@/services/structure-jobs.js';
const mockReturning = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockValues = jest.fn(() => ({ onConflictDoNothing: () => ({ returning: mockReturning }) }));
jest.mock('@/db/workflows-db.js', () => ({
  getWorkflowsDatabase: () => ({
    insert: () => ({ values: mockValues }),
    select: () => ({ from: () => ({ where: mockRead }) }),
    update: () => ({ set: () => ({ where: mockWrite }) }),
  }),
}));
jest.mock('@/services/story-structure.js', () => ({ generateStoryStructure: jest.fn() }));
jest.mock('@/services/structure-lock.js', () => ({ STRUCTURE_DEADLINE_MS: 300000 }));
const params = { storyId: 'story', userDescription: 'same input' };
describe('persisted structure identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockResolvedValue([]);
    mockWrite.mockResolvedValue([]);
  });
  it('only admits work on the winning atomic insert', async () => {
    mockReturning.mockResolvedValue([{ id: 'request' }]);
    await expect(claimStructureJob('request', params, 100)).resolves.toEqual({
      id: 'request',
      created: true,
    });
    expect(mockRead).not.toHaveBeenCalled();
  });
  it('reuses the existing identity and rejects different story or payload', async () => {
    mockRead.mockResolvedValue([
      {
        storyId: 'story',
        inputHash: createHash('sha256').update(JSON.stringify(params)).digest('hex'),
      },
    ]);
    await expect(claimStructureJob('request', params, 100)).resolves.toEqual({
      id: 'request',
      created: false,
    });
    await expect(
      claimStructureJob('request', { ...params, userDescription: 'changed' }, 100),
    ).rejects.toBeInstanceOf(StructureRequestConflict);
    await expect(
      claimStructureJob('request', { ...params, storyId: 'another' }, 100),
    ).rejects.toBeInstanceOf(StructureRequestConflict);
  });
  it('polls persisted results with story ownership metadata after local memory disappears', async () => {
    mockRead.mockResolvedValue([
      {
        id: 'request',
        storyId: 'story',
        status: 'completed',
        startedAt: new Date(),
        estimatedDuration: 100,
        result: { story: { title: 'Ready' } },
      },
    ]);
    expect(await getDurableStructureJob('e9428e21-4f9c-4d3e-8c3b-e49f9a528c22')).toMatchObject({
      id: 'request',
      type: 'story_structure',
      status: 'completed',
      progress: 100,
      metadata: { storyId: 'story' },
      result: { story: { title: 'Ready' } },
    });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});
