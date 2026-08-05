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
import * as identificarCommand from "./commands/identificar.js";
import * as temasCommand from "./commands/temas.js";
import * as filmeCommand from "./commands/filme.js";
import * as mangaCommand from "./commands/manga.js";
import * as calendarioCommand from "./commands/calendario.js";
import * as calendario18Command from "./commands/calendario18.js";
import * as temporadaCommand from "./commands/temporada.js";
import * as statusCommand from "./commands/status.js";
import * as historicoCommand from "./commands/historico.js";
import * as verificarCommand from "./commands/verificar.js";
import * as assinarCommand from "./commands/assinar.js";
import * as assinar18Command from "./commands/assinar18.js";
import { startNotificacaoService } from "./notificacao-service.js";
import { cleanupDuplicateAliases } from "./unified.js";
import { logUsage } from "./usage-logger.js";
import { getPendingAnime, deletePendingAnime } from "./anime-status-store.js";
import { db, listaLeituraTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { StatusLeitura } from "@workspace/db";
import { recordBotError } from "./error-log.js";

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
  [identificarCommand.data.name, identificarCommand],
  [temasCommand.data.name, temasCommand],
  [filmeCommand.data.name, filmeCommand],
  [mangaCommand.data.name, mangaCommand],
  [calendarioCommand.data.name, calendarioCommand],
  [calendario18Command.data.name, calendario18Command],
  [temporadaCommand.data.name, temporadaCommand],
  [statusCommand.data.name, statusCommand],
  [historicoCommand.data.name, historicoCommand],
  [verificarCommand.data.name, verificarCommand],
  [assinarCommand.data.name, assinarCommand],
  [assinar18Command.data.name, assinar18Command],
]);

export async function startBot() {
  const token =
    process.env["DISCORD_BOT_TOKEN"] ??
    process.env["Discord_bot_key"] ??
    process.env["Discord_key"];
  if (!token) {
    logger.error("Token do Discord não configurado. Bot não iniciado.");
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
      void recordBotError({
        source: "discord_commands",
        errorCode: "COMMAND_DEPLOY_FAILED",
        error: err,
        context: { clientId },
      });
    }

    startNotificacaoService(readyClient);

    // Limpeza de aliases duplicados — roda 1h após o boot, depois a cada 24h
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

  client.on(Events.InteractionCreate, async (interaction) => {
    // ── Modal de status do anime ──────────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith("anst_modal_")) {
      const status = interaction.customId.replace("anst_modal_", "") as StatusLeitura;
      const capitulo = interaction.fields.getTextInputValue("capitulo").trim() || null;
      const pending = getPendingAnime(interaction.user.id);

      if (!pending) {
        await interaction.reply({ content: "❌ Sessão expirada. Use `/anime` novamente.", ephemeral: true });
        return;
      }

      deletePendingAnime(interaction.user.id);
      const { anime, originalInteraction } = pending;

      try {
        // Upsert: atualiza se já existe, senão insere
        const existing = await db
          .select({ id: listaLeituraTable.id })
          .from(listaLeituraTable)
          .where(
            and(
              eq(listaLeituraTable.discordUserId, interaction.user.id),
              eq(listaLeituraTable.manhwaId, anime.id),
              eq(listaLeituraTable.source, anime.source)
            )
          );

        if (existing.length) {
          await db
            .update(listaLeituraTable)
            .set({ status, capitulo })
            .where(eq(listaLeituraTable.id, existing[0].id));
        } else {
          await db.insert(listaLeituraTable).values({
            discordUserId: interaction.user.id,
            manhwaId: anime.id,
            source: anime.source,
            title: anime.mainTitle,
            coverUrl: anime.coverUrl ?? null,
            siteUrl: anime.siteUrl,
            genres: anime.genres.join(", "),
            score: anime.score ? String(anime.score) : null,
            status,
            capitulo,
          });
        }

        const capMsg = capitulo ? ` no ep. **${capitulo}**` : "";
        const labels: Record<string, string> = {
          lendo: "📖 Lendo", pausado: "⏸️ Pausado", concluido: "✅ Concluído",
          planejo: "🔖 Planejo Ler", abandonado: "🗑️ Abandonado",
        };
        await interaction.reply({
          content: `${labels[status] ?? status} — **${anime.mainTitle}**${capMsg} salvo na sua lista!`,
          ephemeral: true,
        });
        // Remove botões da mensagem original
        await originalInteraction.editReply({ components: [] }).catch(() => null);
      } catch (err) {
        logger.error({ err }, "Erro ao salvar status do anime");
        await interaction.reply({ content: "❌ Erro ao salvar. Tente novamente.", ephemeral: true });
      }
      return;
    }

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
      void recordBotError({
        source: "command",
        errorCode: "COMMAND_EXECUTION_FAILED",
        error: err,
        discordGuildId: interaction.guildId,
        discordUserId: interaction.user.id,
        command: interaction.commandName,
      });
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
