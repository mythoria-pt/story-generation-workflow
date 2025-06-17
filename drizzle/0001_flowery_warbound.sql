CREATE TYPE "public"."graphical_style" AS ENUM('cartoon', 'realistic', 'watercolor', 'digital_art', 'hand_drawn', 'minimalist', 'vintage', 'comic_book', 'anime', 'pixar_style', 'disney_style', 'sketch', 'oil_painting', 'colored_pencil');--> statement-breakpoint
CREATE TYPE "public"."novel_style" AS ENUM('adventure', 'fantasy', 'mystery', 'romance', 'science_fiction', 'historical', 'contemporary', 'fairy_tale', 'comedy', 'drama', 'horror', 'thriller', 'biography', 'educational', 'poetry');--> statement-breakpoint
CREATE TYPE "public"."target_audience" AS ENUM('children_0-2', 'children_3-6', 'children_7-10', 'children_11-14', 'young_adult_15-17', 'adult_18+', 'all_ages');--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "target_audience" SET DATA TYPE "public"."target_audience" USING "target_audience"::"public"."target_audience";--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "novel_style" SET DATA TYPE "public"."novel_style" USING "novel_style"::"public"."novel_style";--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "graphical_style" SET DATA TYPE "public"."graphical_style" USING "graphical_style"::"public"."graphical_style";--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "story_language" varchar(5) DEFAULT 'en-US' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "html_uri" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "pdf_uri" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "audiobook_uri" jsonb;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "story_generation_status" "run_status";--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "story_generation_completed_percentage" integer DEFAULT 0;