import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "../lib/logger.js";
import { registerBotLifecycle } from "./bootstrap.js";
import { registerInteractionRouter } from "./interaction-router.js";

export async function startBot() {
  const token =
    process.env["DISCORD_BOT_TOKEN"] ??
    process.env["Discord_bot_key"] ??
    process.env["Discord_key"];
  if (!token) {
    logger.error("Token do Discord não configurado. Bot não iniciado.");
    return;
  }

  logger.info({ tokenConfigured: true }, "Token do Discord encontrado, criando client Discord");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { retries: 5 },
  });

  registerBotLifecycle(client, token);
  registerInteractionRouter(client);

  logger.info("Chamando client.login()...");
  let loginTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.login(token),
      new Promise<never>((_, reject) => {
        loginTimeout = setTimeout(() => {
          reject(new Error("O login do Discord não respondeu dentro de 45 segundos"));
        }, 45_000);
      }),
    ]);
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    if (loginTimeout) {
      clearTimeout(loginTimeout);
    }
  }
  logger.info("client.login() retornou — aguardando ClientReady");
}