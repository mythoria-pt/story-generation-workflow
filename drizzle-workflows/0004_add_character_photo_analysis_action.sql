-- Add 'character_photo_analysis' value to ai_action_type enum (workflows DB)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'ai_action_type' AND e.enumlabel = 'character_photo_analysis') THEN
    ALTER TYPE ai_action_type ADD VALUE 'character_photo_analysis' AFTER 'blog_translation';
  END IF;
END$$;
