CREATE TABLE IF NOT EXISTS "error_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "discord_guild_id" text,
  "discord_user_id" text,
  "command" text,
  "route" text,
  "error_code" text NOT NULL,
  "message" text NOT NULL,
  "http_status" integer,
  "context" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "error_logs_guild_created_at_idx"
  ON "error_logs" ("discord_guild_id", "created_at");

CREATE INDEX IF NOT EXISTS "error_logs_created_at_idx"
  ON "error_logs" ("created_at");