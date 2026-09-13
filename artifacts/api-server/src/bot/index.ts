import { Client, Events, GatewayIntentBits } from "discord.js";
import { logger } from "../lib/logger.js";
import { registerBotLifecycle } from "./bootstrap.js";
import { registerInteractionRouter } from "./interaction-router.js";

const LOGIN_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 10_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeBotToken(token: string) {
  return token.replace(/^Bot\s+/i, "").trim();
}

async function validateDiscordToken(token: string) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${normalizeBotToken(token)}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Discord rejeitou o token (HTTP ${response.status})`);
  }

  const account = (await response.json()) as { id?: string; username?: string };
  logger.info(
    { applicationId: account.id, username: account.username },
    "Token do Discord validado pela API",
  );
}

function registerGatewayDiagnostics(client: Client) {
  client.on("warn", (message) => {
    logger.warn({ message }, "Aviso do gateway do Discord");
  });

  client.on("shardError", (error, shardId) => {
    logger.error({ err: error, shardId }, "Erro de conexão com o gateway do Discord");
  });

  client.on("invalidated", () => {
    logger.error("A sessão do bot foi invalidada pelo Discord");
  });

  client.on("debug", (message) => {
    if (/invalid|error|close|disconnect|identify|resume|gateway/i.test(message)) {
      logger.info({ message }, "Diagnóstico do gateway do Discord");
    }
  });
}

async function loginAndWaitForReady(client: Client, token: string) {
  const ready = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });

  const login = client.login(token);
  await Promise.race([
    Promise.all([login, ready]),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Discord não emitiu ClientReady em ${LOGIN_TIMEOUT_MS / 1000}s`)),
        LOGIN_TIMEOUT_MS,
      ),
    ),
  ]);
}

function createClient(token: string) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { retries: 5 },
  });

  registerBotLifecycle(client, token);
  registerInteractionRouter(client);
  registerGatewayDiagnostics(client);
  return client;
}

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

  await validateDiscordToken(token);

  let attempt = 0;
  while (true) {
    attempt += 1;
    const client = createClient(token);

    try {
      logger.info({ attempt }, "Chamando client.login()...");
      await loginAndWaitForReady(client, token);
      logger.info({ attempt }, "client.login() concluiu e ClientReady foi recebido");
      return;
    } catch (error) {
      logger.error(
        { err: error, attempt },
        "Falha ao conectar ao gateway do Discord; nova tentativa será feita",
      );
      client.destroy();
      await sleep(RETRY_DELAY_MS);
    }
  }
}