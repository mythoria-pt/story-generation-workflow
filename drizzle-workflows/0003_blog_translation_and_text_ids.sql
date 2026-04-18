-- Extend token usage tracking to support blog translations and non-UUID identifiers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'ai_action_type'
      AND e.enumlabel = 'blog_translation'
  ) THEN
    ALTER TYPE ai_action_type ADD VALUE 'blog_translation' AFTER 'prompt_rewrite';
  END IF;
END$$;

ALTER TABLE "token_usage_tracking"
  ALTER COLUMN "author_id" TYPE text USING "author_id"::text,
  ALTER COLUMN "story_id" TYPE text USING "story_id"::text;
