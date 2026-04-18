-- Add 'email_asset_generation' value to ai_action_type enum (workflows DB)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'ai_action_type' AND e.enumlabel = 'email_asset_generation') THEN
    ALTER TYPE ai_action_type ADD VALUE 'email_asset_generation' AFTER 'character_photo_analysis';
  END IF;
END$$;
