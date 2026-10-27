import { consumeStoryGuideQuota, StoryGuideQuotaError } from '@/services/story-guide-quota.js';
import { PgDialect } from 'drizzle-orm/pg-core';
const mockExecute = jest.fn();
const mockTransaction = jest.fn(async (fn) => fn({ execute: mockExecute }));
jest.mock('@/db/workflows-db.js', () => ({
  getWorkflowsDatabase: () => ({ transaction: mockTransaction }),
}));
describe('distributed story guide quota', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [{ used: 1 }] });
  });
  it('debits both limits atomically using UTC day and stable counter ordering', async () => {
    await consumeStoryGuideQuota('author', 'journey', new Date('2026-09-19T23:30:00-02:00'));
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const queries = mockExecute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
    expect(queries[0].params).toEqual(['author:author:2026-09-20', 30]);
    expect(queries[1].params).toEqual(['journey:author:journey', 9]);
    for (const query of queries) {
      expect(query.sql).toContain('ON CONFLICT');
      expect(query.sql).toContain('WHERE story_guide_quota.used <');
    }
  });
  it.each([0, 1])('rejects a saturated counter %i so the transaction rolls back', async (index) => {
    if (index === 1) mockExecute.mockResolvedValueOnce({ rows: [{ used: 30 }] });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(consumeStoryGuideQuota('a', 'g')).rejects.toBeInstanceOf(StoryGuideQuotaError);
    expect(mockExecute).toHaveBeenCalledTimes(index + 1);
  });
});
