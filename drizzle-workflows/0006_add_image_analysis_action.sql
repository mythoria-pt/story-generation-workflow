-- Add 'image_analysis' value to ai_action_type enum (workflows DB)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'ai_action_type' AND e.enumlabel = 'image_analysis') THEN
    ALTER TYPE ai_action_type ADD VALUE 'image_analysis' AFTER 'character_photo_analysis';
  END IF;
END$$;
