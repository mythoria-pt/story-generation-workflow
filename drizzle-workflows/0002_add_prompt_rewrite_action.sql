-- Add 'prompt_rewrite' value to ai_action_type enum (workflows DB)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'ai_action_type' AND e.enumlabel = 'prompt_rewrite') THEN
    ALTER TYPE ai_action_type ADD VALUE 'prompt_rewrite' AFTER 'image_edit';
  END IF;
END$$;
