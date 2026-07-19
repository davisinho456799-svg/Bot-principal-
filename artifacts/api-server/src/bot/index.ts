import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { deployCommands } from "./deploy-commands.js";
import * as searchCommand from "./commands/search.js";
import * as topCommand from "./commands/top.js";
import * as recomendarCommand from "./commands/recomendar.js";
import * as ajudaCommand from "./commands/ajuda.js";
import * as aleatorioCommand from "./commands/aleatorio.js";
import * as lancamentosCommand from "./commands/lancamentos.js";
import * as favoritosCommand from "./commands/favoritos.js";
import * as compararCommand from "./commands/comparar.js";
import * as autorCommand from "./commands/autor.js";
import * as notificarCommand from "./commands/notificar.js";
import * as listaCommand from "./commands/lista.js";
import * as rankingCommand from "./commands/ranking.js";
import * as perfilCommand from "./commands/perfil.js";
import * as similarCommand from "./commands/similar.js";
import * as buscarCommand from "./commands/buscar.js";
import * as animeCommand from "./commands/anime.js";
import * as vnCommand from "./commands/vn.js";
import * as adminCommand from "./commands/admin.js";
import * as noticiasCommand from "./commands/noticias.js";
import { startNotificacaoService } from "./notificacao-service.js";
import { logUsage } from "./usage-logger.js";

type Command = {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
};

const commands = new Map<string, Command>([
  [searchCommand.data.name, searchCommand],
  [topCommand.data.name, topCommand],
  [recomendarCommand.data.name, recomendarCommand],
  [ajudaCommand.data.name, ajudaCommand],
  [aleatorioCommand.data.name, aleatorioCommand],
  [lancamentosCommand.data.name, lancamentosCommand],
  [favoritosCommand.data.name, favoritosCommand],
  [compararCommand.data.name, compararCommand],
  [autorCommand.data.name, autorCommand],
  [notificarCommand.data.name, notificarCommand],
  [listaCommand.data.name, listaCommand],
  [rankingCommand.data.name, rankingCommand],
  [perfilCommand.data.name, perfilCommand],
  [similarCommand.data.name, similarCommand],
  [buscarCommand.data.name, buscarCommand],
  [animeCommand.data.name, animeCommand],
  [vnCommand.data.name, vnCommand],
  [adminCommand.data.name, adminCommand],
  [noticiasCommand.data.name, noticiasCommand],
]);

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN não configurado. Bot não iniciado.");
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { retries: 5 },
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, "Bot do Discord conectado");

    const clientId = readyClient.user.id;
    try {
      await deployCommands(clientId, token);
    } catch (err) {
      logger.error({ err }, "Falha ao registrar comandos");
    }

    startNotificacaoService(readyClient);
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
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch {
          // Autocomplete silently falha — nunca responder com erro visível
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    // Log de uso (fire-and-forget, nunca bloqueia o comando)
    void logUsage({
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      guildId: interaction.guildId,
      command: interaction.commandName,
      query: interaction.options.getString("titulo")
        ?? interaction.options.getString("busca")
        ?? interaction.options.getString("nome")
        ?? interaction.options.getString("query")
        ?? interaction.options.getString("obra")
        ?? null,
    });

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, "Erro ao executar comando");
      const msg = { content: "❌ Ocorreu um erro ao executar esse comando.", ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  });

  await client.login(token);
}
