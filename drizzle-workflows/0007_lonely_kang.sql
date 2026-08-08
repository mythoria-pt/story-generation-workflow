ALTER TABLE "story_generation_runs" ADD COLUMN "failure_stage" varchar(120);--> statement-breakpoint
ALTER TABLE "story_generation_runs" ADD COLUMN "failure_code" varchar(120);
