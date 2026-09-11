import { Client, Events } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { deployCommands } from "./deploy-commands.js";
import { startNotificacaoService, startWeeklyService } from "./notificacao-service.js";
import { cleanupDuplicateAliases } from "./unified.js";
import { recordBotError } from "./error-log.js";

export function registerBotLifecycle(client: Client, token: string) {
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(
      { tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
      "Bot do Discord conectado",
    );

    const clientId = readyClient.user.id;
    try {
      await deployCommands(clientId, token, [...readyClient.guilds.cache.keys()]);
    } catch (err) {
      logger.error({ err }, "Falha ao registrar comandos");
      void recordBotError({
        source: "discord_commands",
        errorCode: "COMMAND_DEPLOY_FAILED",
        error: err,
        context: { clientId },
      });
    }

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
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn({ code: event.code, shardId }, "Bot desconectado do Discord — reconectando...");
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info({ shardId }, "Bot reconectando ao Discord...");
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info({ shardId, replayedEvents }, "Bot reconectado ao Discord.");
  });

  client.on("error", (err) => {
    logger.error({ err }, "Erro no cliente do Discord");
    void recordBotError({
      source: "discord_client",
      errorCode: "DISCORD_CLIENT_ERROR",
      error: err,
    });
  });
}