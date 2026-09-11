import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { deployCommands } from "./deploy-commands.js";
import { commandRegistry as commands } from "./command-registry.js";
import { startNotificacaoService, startWeeklyService } from "./notificacao-service.js";
import { cleanupDuplicateAliases } from "./unified.js";
import { logUsage } from "./usage-logger.js";
import { getPendingAnime, deletePendingAnime } from "./anime-status-store.js";
import { db, listaLeituraTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { StatusLeitura } from "@workspace/db";
import { recordBotError } from "./error-log.js";
import {
  config as getDiscordConfig,
  getConfiguredSeasonPage,
} from "../routes/discord.js";

export async function startBot() {
  const token =
    process.env["DISCORD_BOT_TOKEN"] ??
    process.env["Discord_bot_key"] ??
    process.env["Discord_key"];
  if (!token) {
    logger.error("Token do Discord não configurado. Bot não iniciado.");
    return;
  }

  logger.info({ tokenLen: token.length, tokenPrefix: token.slice(0, 10) }, "Token encontrado, criando client Discord");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { retries: 5 },
  });
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, "Bot do Discord conectado");

    const clientId = readyClient.user.id;
    try {
      await deployCommands(
        clientId,
        token,
        [...readyClient.guilds.cache.keys()],
      );
    } catch (err) {
      logger.error({ err }, "Falha ao registrar comandos");
      void recordBotError({
        source: "discord_commands",
        errorCode: "COMMAND_DEPLOY_FAILED",
        error: err,
        context: { clientId },
      });
    }

    // Migração automática — garante que colunas novas existem no banco de produção
    try {
      await db.execute(sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP`);
      logger.info("Migração automática: last_notified_at verificada");
       await db.execute(sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS weekly_start_chapters REAL`);
       await db.execute(sql`ALTER TABLE capitulos_rastreados ADD COLUMN IF NOT EXISTS weekly_start_at TIMESTAMP`);
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

    if (
      interaction.isButton() &&
      (interaction.customId.startsWith("season_page_prev_") ||
        interaction.customId.startsWith("season_page_next_"))
    ) {
      const configured = await getDiscordConfig();
      if (configured.messageId && interaction.message.id !== configured.messageId) {
        await interaction.reply({
          content: "Esta tabela já foi substituída pela versão mais recente.",
          ephemeral: true,
        });
        return;
      }

      const currentPage = Number(interaction.customId.split("_").pop());
      const direction = interaction.customId.startsWith("season_page_next_") ? 1 : -1;
      const targetPage = Number.isFinite(currentPage) ? Math.max(0, currentPage + direction) : 0;

      await interaction.deferUpdate();
      try {
        const payload = await getConfiguredSeasonPage(targetPage);
        await interaction.editReply(payload);
      } catch (err) {
        logger.error({ err }, "Falha ao mudar página da tabela de temporada");
        await interaction
          .followUp({
            content: "Não foi possível carregar esta página agora. Tente novamente.",
            ephemeral: true,
          })
          .catch(() => null);
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      const receivedAt = Date.now();
      const command = commands.get(interaction.commandName);
      logger.info({
        command: interaction.commandName,
        dispatchDelayMs: Math.max(0, receivedAt - interaction.createdTimestamp),
      }, "Autocomplete recebido");
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (err) {
          // Autocomplete silently falha — nunca responder com erro visível
          logger.warn({ err, command: interaction.commandName }, "Autocomplete falhou no despacho");
        }
      } else {
        await interaction.respond([]).catch(() => null);
      }
      logger.info({
        command: interaction.commandName,
        handlerDurationMs: Date.now() - receivedAt,
        totalSinceDiscordMs: Math.max(0, Date.now() - interaction.createdTimestamp),
        responded: interaction.responded,
      }, "Autocomplete finalizado");
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      await interaction.reply({
        content: "⚠️ Este comando está desatualizado. Aguarde a sincronização dos comandos do bot.",
        ephemeral: true,
      }).catch(() => null);
      return;
    }

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
        ?? (() => {
          const obraId = interaction.options.getInteger("obra");
          return obraId === null ? null : String(obraId);
        })()
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

  logger.info("Chamando client.login()...");
  await client.login(token);
  logger.info("client.login() retornou — aguardando ClientReady");
}
