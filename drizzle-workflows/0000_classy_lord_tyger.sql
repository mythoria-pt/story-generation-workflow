CREATE TYPE "public"."ai_action_type" AS ENUM('story_structure', 'story_outline', 'chapter_writing', 'image_generation', 'story_review', 'character_generation', 'story_enhancement', 'audio_generation', 'content_validation', 'image_edit', 'test');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'failed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'failed', 'completed');--> statement-breakpoint
CREATE TABLE "story_generation_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"gcp_workflow_execution" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"current_step" varchar(120),
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_generation_steps" (
	"run_id" uuid NOT NULL,
	"step_name" varchar(120) NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"detail_json" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_generation_steps_run_id_step_name_pk" PRIMARY KEY("run_id","step_name")
);
--> statement-breakpoint
CREATE TABLE "token_usage_tracking" (
	"token_usage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"action" "ai_action_type" NOT NULL,
	"ai_model" varchar(100) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost_in_euros" numeric(10, 6) NOT NULL,
	"input_prompt_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_generation_steps" ADD CONSTRAINT "story_generation_steps_run_id_story_generation_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."story_generation_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_generation_runs_story_id_idx" ON "story_generation_runs" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "story_generation_runs_status_idx" ON "story_generation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "story_generation_runs_created_at_idx" ON "story_generation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "story_generation_steps_run_id_idx" ON "story_generation_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "story_generation_steps_status_idx" ON "story_generation_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "token_usage_story_id_idx" ON "token_usage_tracking" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "token_usage_author_id_idx" ON "token_usage_tracking" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "token_usage_created_at_idx" ON "token_usage_tracking" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "token_usage_author_id_created_at_idx" ON "token_usage_tracking" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "token_usage_action_idx" ON "token_usage_tracking" USING btree ("action");--> statement-breakpoint
CREATE INDEX "token_usage_ai_model_idx" ON "token_usage_tracking" USING btree ("ai_model");