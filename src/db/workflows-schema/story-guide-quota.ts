import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Counters only: no prompts, answers or story records. Journey counters do not expire.
export const storyGuideQuota = pgTable('story_guide_quota', {
  key: text('key').primaryKey(),
  used: integer('used').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
