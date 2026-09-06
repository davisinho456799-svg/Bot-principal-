import { Client } from "discord.js";
import { Riffy } from "riffy";
import { logger } from "../lib/logger.js";

type LavalinkManager = any;
type LavalinkPlayer = any;

let manager: LavalinkManager | null = null;

function getRequiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

export function initLavalink(client: Client): LavalinkManager | null {
  const host = getRequiredEnv("LAVALINK_HOST");
  const password = getRequiredEnv("LAVALINK_PASSWORD");

  if (!host || !password) {
    logger.warn(
      "Lavalink desativado: defina LAVALINK_HOST e LAVALINK_PASSWORD",
    );
    return null;
  }

  const port = Number(process.env["LAVALINK_PORT"] ?? 2333);
  const secure = process.env["LAVALINK_SECURE"] === "true";
  const name = getRequiredEnv("LAVALINK_NAME") ?? "railway-lavalink";
  const searchPlatform =
    getRequiredEnv("LAVALINK_SEARCH_PLATFORM") ?? "ytmsearch";

  logger.info(
    { host, port, secure, name, searchPlatform },
    "Configurando conexão com Lavalink",
  );

  manager = new Riffy(
    client as any,
    [
      {
        name,
        host,
        port,
        password,
        secure,
      },
    ],
    {
      send: (packet: any) => {
        const guild = client.guilds.cache.get(packet?.d?.guild_id);
        if (guild) guild.shard.send(packet);
      },
      defaultSearchPlatform: searchPlatform,
      restVersion: "v4",
    } as any,
  );

  client.on("raw", (packet: any) => {
    if (packet?.t === "VOICE_STATE_UPDATE" || packet?.t === "VOICE_SERVER_UPDATE") {
      manager?.updateVoiceState(packet);
    }
  });

  manager.on("nodeConnect", (node: any) => {
    logger.info({ node: node?.name ?? name }, "Lavalink conectado");
  });
  manager.on("nodeReconnect", (node: any) => {
    logger.warn({ node: node?.name ?? name }, "Lavalink reconectando");
  });
  manager.on("nodeDisconnect", (node: any, reason: any) => {
    logger.warn(
      { node: node?.name ?? name, reason },
      "Lavalink desconectado",
    );
  });
  manager.on("nodeError", (node: any, error: any) => {
    const errorDetails =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            code: (error as NodeJS.ErrnoException).code,
            stack: error.stack,
          }
        : {
            name: error?.name,
            message: error?.message,
            code: error?.code,
            type: error?.type,
          };
    logger.error(
      { node: node?.name ?? name, error: errorDetails },
      "Erro no nó Lavalink",
    );
  });
  manager.on("trackError", (player: any, track: any, error: any) => {
    logger.error(
      {
        guildId: player?.guildId,
        title: track?.info?.title,
        error,
      },
      "Erro ao reproduzir faixa no Lavalink",
    );
  });
  manager.on("trackStuck", (player: any, track: any, data: any) => {
    logger.warn(
      {
        guildId: player?.guildId,
        title: track?.info?.title,
        data,
      },
      "Faixa travada no Lavalink",
    );
  });
  manager.on("trackStart", (player: any, track: any) => {
    logger.info(
      {
        guildId: player?.guildId,
        title: track?.info?.title,
      },
      "Faixa iniciada no Lavalink",
    );
  });
  manager.on("queueEnd", (player: any) => {
    logger.info({ guildId: player?.guildId }, "Fila Lavalink encerrada");
    player?.destroy();
  });

  const initialize = () => {
    if (!manager || !client.user) return;
    logger.info("Inicializando conexão com Lavalink");
    try {
      const result = manager.init(client.user.id);
      if (result && typeof result.catch === "function") {
        void result.catch((error: unknown) => {
          logger.error({ error }, "Falha ao inicializar Lavalink");
        });
      }
    } catch (error) {
      logger.error({ error }, "Falha ao inicializar Lavalink");
    }
  };

  if (client.isReady()) {
    initialize();
  } else {
    client.once("ready", initialize);
  }

  return manager;
}

export function getLavalink(): LavalinkManager | null {
  return manager;
}

export function getLavalinkPlayer(guildId: string): LavalinkPlayer | null {
  return manager?.players?.get(guildId) ?? null;
}