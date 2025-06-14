import { pgTable, uuid, text, varchar, timestamp, jsonb, foreignKey, primaryKey } from "drizzle-orm/pg-core";
import { runStatusEnum, stepStatusEnum } from "./enums.js";
import { stories } from "./stories.js";

// -----------------------------------------------------------------------------
// Story Generation Tables
// -----------------------------------------------------------------------------

export const storyGenerationRuns = pgTable("story_generation_runs", {
	runId: uuid("run_id").defaultRandom().primaryKey().notNull(),
	storyId: uuid("story_id").notNull(),
	gcpWorkflowExecution: text("gcp_workflow_execution"),
	status: runStatusEnum().default('queued').notNull(),
	currentStep: varchar("current_step", { length: 120 }),
	errorMessage: text("error_message"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
		columns: [table.storyId],
		foreignColumns: [stories.storyId],
		name: "story_generation_runs_story_id_stories_story_id_fk"
	}).onDelete("cascade"),
]);

export const storyGenerationSteps = pgTable("story_generation_steps", {
	runId: uuid("run_id").notNull(),
	stepName: varchar("step_name", { length: 120 }).notNull(),
	status: stepStatusEnum().default('pending').notNull(),
	detailJson: jsonb("detail_json"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
		columns: [table.runId],
		foreignColumns: [storyGenerationRuns.runId],
		name: "story_generation_steps_run_id_story_generation_runs_run_id_fk"
	}).onDelete("cascade"),
	primaryKey({ columns: [table.runId, table.stepName], name: "story_generation_steps_run_id_step_name_pk"}),
]);
