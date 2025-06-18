import { pgTable, uuid, varchar, timestamp, text, jsonb, integer, foreignKey } from "drizzle-orm/pg-core";
import { authors } from './authors.js';
import { storyStatusEnum, targetAudienceEnum, novelStyleEnum, graphicalStyleEnum, runStatusEnum } from './enums.js';

// -----------------------------------------------------------------------------
// Stories domain
// -----------------------------------------------------------------------------

// Stories
export const stories = pgTable("stories", {
  storyId: uuid("story_id").defaultRandom().primaryKey().notNull(),
  authorId: uuid("author_id").notNull(),
  title: varchar({ length: 255 }).notNull(),
  plotDescription: text("plot_description"),
  storyLanguage: varchar("story_language", { length: 5 }).default('en-US').notNull(),
  synopsis: text(),
  place: text(),
  additionalRequests: text(),
  targetAudience: targetAudienceEnum("target_audience"),
  novelStyle: novelStyleEnum("novel_style"),
  graphicalStyle: graphicalStyleEnum("graphical_style"),
  chapterCount: integer("chapter_count").default(6).notNull(),
  status: storyStatusEnum().default('draft'),
  features: jsonb(),
  deliveryAddress: jsonb("delivery_address"),
  dedicationMessage: text("dedication_message"),
  mediaLinks: jsonb("media_links"),
  htmlUri: text("html_uri"), // Internal Google Storage link to access the HTML file
  pdfUri: text("pdf_uri"), // Internal Google Storage link to access the PDF file
  audiobookUri: jsonb("audiobook_uri"), // JSON object with internal GS links to each chapter audio file
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  storyGenerationStatus: runStatusEnum("story_generation_status"),
  storyGenerationCompletedPercentage: integer("story_generation_completed_percentage").default(0),
}, (table) => [
  foreignKey({
    columns: [table.authorId],
    foreignColumns: [authors.authorId],
    name: "stories_author_id_authors_author_id_fk"
  }).onDelete("cascade"),
]);

// Story versions
export const storyVersions = pgTable("story_versions", {
  storyVersionId: uuid("story_version_id").defaultRandom().primaryKey().notNull(),
  storyId: uuid("story_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  textJsonb: jsonb("text_jsonb").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.storyId],
    foreignColumns: [stories.storyId],
    name: "story_versions_story_id_stories_story_id_fk"
  }).onDelete("cascade"),
]);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export type Story = typeof stories.$inferSelect;
export type NewStory = typeof stories.$inferInsert;

export type StoryVersion = typeof storyVersions.$inferSelect;
export type NewStoryVersion = typeof storyVersions.$inferInsert;
