-- Ledger idempotente para impedir que o mesmo capítulo seja enviado mais de
-- uma vez ao mesmo canal após reinício ou falha ao atualizar o rastreador.
CREATE TABLE IF NOT EXISTS "notificacao_eventos" (
  "event_key" text PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL,
  "title" text NOT NULL,
  "chapter" real NOT NULL,
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  "sent_at" timestamp
);