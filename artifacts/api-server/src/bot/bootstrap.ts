import { Client, Events } from "discord.js";
import { logger } from "../lib/logger.js";
import { deployCommands } from "./deploy-commands.js";
import { runBotStartupTasks } from "./startup-tasks.js";
import { recordBotError } from "./error-log.js";

function isDiscordRateLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "RateLimitError";
}

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

    await runBotStartupTasks(readyClient);
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
    if (isDiscordRateLimitError(err)) {
      logger.warn({ err }, "Rate limit do Discord emitido pelo cliente");
      return;
    }

    logger.error({ err }, "Erro no cliente do Discord");
    void recordBotError({
      source: "discord_client",
      errorCode: "DISCORD_CLIENT_ERROR",
      error: err,
    });
  });
}