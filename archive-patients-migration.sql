-- Add archive support to children table
ALTER TABLE children ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false;
ALTER TABLE children ADD COLUMN IF NOT EXISTS archived_at timestamptz;
