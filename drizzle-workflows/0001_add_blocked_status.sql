-- Add 'blocked' value to run_status enum (workflows DB)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'run_status' AND e.enumlabel = 'blocked') THEN
    ALTER TYPE run_status ADD VALUE 'blocked' AFTER 'cancelled';
  END IF;
END$$;
