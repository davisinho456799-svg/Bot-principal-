-- Align existing Neon databases with the error_logs schema used by the bot.
-- IF NOT EXISTS keeps this safe to run after a partial/manual deployment.
ALTER TABLE "error_logs"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'api' NOT NULL;

ALTER TABLE "error_logs"
  ADD COLUMN IF NOT EXISTS "route" text;