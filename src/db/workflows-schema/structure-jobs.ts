import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const structureJobs = pgTable('structure_jobs', {
  id: uuid('id').primaryKey(),
  storyId: uuid('story_id').notNull(),
  inputHash: text('input_hash').notNull(),
  status: text('status').notNull().default('pending'),
  estimatedDuration: integer('estimated_duration').notNull(),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
