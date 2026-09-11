import type { Client } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { startNotificacaoService, startWeeklyService } from "./notificacao-service.js";
import { cleanupDuplicateAliases } from "./unified.js";

export async function runBotStartupTasks(readyClient: Client<true>) {
  try {
    await db.execute(
      sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP`,
    );
    logger.info("Migração automática: last_notified_at verificada");
    await db.execute(
      sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS weekly_start_chapters REAL`,
    );
    await db.execute(
      sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS weekly_start_at TIMESTAMP`,
    );
    logger.info("Migração automática: snapshot semanal verificado");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS notificacao_eventos (
        event_key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        chapter REAL NOT NULL,
        claimed_at TIMESTAMP NOT NULL DEFAULT now(),
        sent_at TIMESTAMP
      )
    `);
    logger.info("Migração automática: notificacao_eventos verificada");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS release_preferences (
        discord_user_id TEXT PRIMARY KEY,
        notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        adult_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        digest_mode TEXT NOT NULL DEFAULT 'imediato',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info("Migração automática: release_preferences verificada");
  } catch (err) {
    logger.error({ err }, "Falha na migração automática — bot continuará normalmente");
  }

  startNotificacaoService(readyClient);
  startWeeklyService(readyClient);

  setTimeout(() => {
    cleanupDuplicateAliases()
      .then(({ removed }) => {
        if (removed > 0) logger.info({ removed }, "Aliases duplicados removidos do banco");
      })
      .catch(() => null);

    setInterval(() => {
      cleanupDuplicateAliases()
        .then(({ removed }) => {
          if (removed > 0) logger.info({ removed }, "Aliases duplicados removidos do banco");
        })
        .catch(() => null);
    }, 24 * 60 * 60 * 1000);
  }, 60 * 60 * 1000);
}