-- Existing baseline/historical rows remain ineligible for automatic delivery.
-- Apply to the external production database before deploying the new worker.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE detected_chapters
  ADD COLUMN IF NOT EXISTS delivery_pending boolean NOT NULL DEFAULT false;
COMMIT;