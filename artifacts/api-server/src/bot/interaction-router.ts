import { Events, type Client } from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, listaLeituraTable } from "@workspace/db";
import type { StatusLeitura } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { commandRegistry as commands } from "./command-registry.js";
import { logUsage } from "./usage-logger.js";
import { getPendingAnime, deletePendingAnime } from "./anime-status-store.js";
import { recordBotError } from "./error-log.js";
import {
  config as getDiscordConfig,
  getConfiguredSeasonPage,
} from "../routes/discord.js";
import {
  InteractionCallbackCooldownError,
  interactionCallbackCooldownRemaining,
  isInteractionCallbackUnavailable,
} from "./interaction-rate-limit.js";

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_RESPONSE_INTERVAL_MS = 1_000;
const latestAutocompleteRequest = new Map<string, number>();
const lastAutocompleteResponse = new Map<string, number>();
let autocompleteRequestSequence = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerInteractionRouter(client: Client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    const receivedAt = Date.now();
    logger.info(
      {
        interactionType: interaction.type,
        interactionId: interaction.id,
        command: interaction.isChatInputCommand() || interaction.isAutocomplete()
          ? interaction.commandName
          : undefined,
        customId: "customId" in interaction ? interaction.customId : undefined,
        guildId: interaction.guildId,
      },
      "Interação do Discord recebida",
    );

    if (interaction.isModalSubmit() && interaction.customId.startsWith("anst_modal_")) {
      const status = interaction.customId.replace("anst_modal_", "") as StatusLeitura;
      const capitulo = interaction.fields.getTextInputValue("capitulo").trim() || null;
      const pending = getPendingAnime(interaction.user.id);

      if (!pending) {
        await interaction.reply({
          content: "❌ Sessão expirada. Use `/anime` novamente.",
          ephemeral: true,
        });
        return;
      }

      deletePendingAnime(interaction.user.id);
      const { anime, originalInteraction } = pending;

      try {
        const existing = await db
          .select({ id: listaLeituraTable.id })
          .from(listaLeituraTable)
          .where(
            and(
              eq(listaLeituraTable.discordUserId, interaction.user.id),
              eq(listaLeituraTable.manhwaId, anime.id),
              eq(listaLeituraTable.source, anime.source),
            ),
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
          lendo: "📖 Lendo",
          pausado: "⏸️ Pausado",
          concluido: "✅ Concluído",
          planejo: "🔖 Planejo Ler",
          abandonado: "🗑️ Abandonado",
        };
        await interaction.reply({
          content: `${labels[status] ?? status} — **${anime.mainTitle}**${capMsg} salvo na sua lista!`,
          ephemeral: true,
        });
        await originalInteraction.editReply({ components: [] }).catch(() => null);
      } catch (err) {
        logger.error({ err }, "Erro ao salvar status do anime");
        await interaction.reply({
          content: "❌ Erro ao salvar. Tente novamente.",
          ephemeral: true,
        });
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
      const autocompleteKey = `${interaction.user.id}:${interaction.commandName}`;
      const focusedValue = interaction.options.getFocused();

      if (
        interaction.commandName === "anime" &&
        typeof focusedValue === "string" &&
        focusedValue.trim().length < 2
      ) {
        logger.debug(
          { command: interaction.commandName, interactionId: interaction.id },
          "Autocomplete sem consulta suficiente ignorado",
        );
        return;
      }

      const requestSequence = ++autocompleteRequestSequence;
      latestAutocompleteRequest.set(autocompleteKey, requestSequence);

      await wait(AUTOCOMPLETE_DEBOUNCE_MS);
      const isLatestAutocomplete = () =>
        latestAutocompleteRequest.get(autocompleteKey) === requestSequence;
      if (!isLatestAutocomplete()) {
        logger.debug(
          {
            command: interaction.commandName,
            interactionId: interaction.id,
            debounceMs: AUTOCOMPLETE_DEBOUNCE_MS,
          },
          "Autocomplete intermediário ignorado",
        );
        return;
      }

      let responseAttempted = false;
      const originalRespond = interaction.respond.bind(interaction);
      interaction.respond = async (options) => {
        if (!isLatestAutocomplete() || interaction.responded || responseAttempted) {
          logger.debug(
            { command: interaction.commandName, interactionId: interaction.id },
            "Resposta obsoleta ou duplicada de autocomplete ignorada",
          );
          return;
        }

        const cooldownRemainingMs = interactionCallbackCooldownRemaining();
        if (cooldownRemainingMs > 0) {
          responseAttempted = true;
          logger.debug(
            {
              command: interaction.commandName,
              interactionId: interaction.id,
              cooldownRemainingMs,
            },
            "Autocomplete ignorado durante cooldown do Discord",
          );
          return;
        }

        const now = Date.now();
        const previousResponseAt = lastAutocompleteResponse.get(autocompleteKey) ?? 0;
        if (now - previousResponseAt < AUTOCOMPLETE_RESPONSE_INTERVAL_MS) {
          responseAttempted = true;
          logger.debug(
            {
              command: interaction.commandName,
              interactionId: interaction.id,
              minIntervalMs: AUTOCOMPLETE_RESPONSE_INTERVAL_MS,
            },
            "Autocomplete ignorado para limitar callbacks",
          );
          return;
        }

        responseAttempted = true;
        lastAutocompleteResponse.set(autocompleteKey, now);
        setTimeout(() => {
          if (lastAutocompleteResponse.get(autocompleteKey) === now) {
            lastAutocompleteResponse.delete(autocompleteKey);
          }
        }, AUTOCOMPLETE_RESPONSE_INTERVAL_MS);
        return originalRespond(options);
      };

      try {
        logger.info(
          {
            command: interaction.commandName,
            dispatchDelayMs: Math.max(0, receivedAt - interaction.createdTimestamp),
          },
          "Autocomplete recebido",
        );
        if (command?.autocomplete) {
          try {
            await command.autocomplete(interaction);
          } catch (err) {
            if (!isInteractionCallbackUnavailable(err)) {
              logger.warn(
                { err, command: interaction.commandName },
                "Autocomplete falhou no despacho",
              );
            }
          }
        } else {
          await interaction.respond([]).catch(() => null);
        }
        logger.info(
          {
            command: interaction.commandName,
            handlerDurationMs: Date.now() - receivedAt,
            totalSinceDiscordMs: Math.max(0, Date.now() - interaction.createdTimestamp),
            responded: interaction.responded,
          },
          "Autocomplete finalizado",
        );
      } finally {
        if (isLatestAutocomplete()) latestAutocompleteRequest.delete(autocompleteKey);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn(
        { command: interaction.commandName, guildId: interaction.guildId },
        "Comando recebido, mas ausente no registry local",
      );
      await interaction
        .reply({
          content: "⚠️ Este comando está desatualizado. Aguarde a sincronização dos comandos do bot.",
          ephemeral: true,
        })
        .catch(() => null);
      return;
    }

    logger.info(
      { command: interaction.commandName, guildId: interaction.guildId },
      "Despachando comando do Discord",
    );

    let initialResponseAttempted = false;
    const originalReply = interaction.reply.bind(interaction);
    const originalDeferReply = interaction.deferReply.bind(interaction);
    const trackedInteraction = interaction as unknown as {
      reply: (options: any) => Promise<unknown>;
      deferReply: (options?: any) => Promise<unknown>;
    };
    trackedInteraction.reply = async (options: any) => {
      initialResponseAttempted = true;
      const cooldownRemainingMs = interactionCallbackCooldownRemaining();
      if (cooldownRemainingMs > 0) {
        throw new InteractionCallbackCooldownError(cooldownRemainingMs);
      }
      return originalReply(options);
    };
    trackedInteraction.deferReply = async (options?: any) => {
      initialResponseAttempted = true;
      const cooldownRemainingMs = interactionCallbackCooldownRemaining();
      if (cooldownRemainingMs > 0) {
        throw new InteractionCallbackCooldownError(cooldownRemainingMs);
      }
      return originalDeferReply(options);
    };

    void logUsage({
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      guildId: interaction.guildId,
      command: interaction.commandName,
      query:
        interaction.options.getString("titulo") ??
        interaction.options.getString("busca") ??
        interaction.options.getString("nome") ??
        interaction.options.getString("query") ??
        (() => {
          const obraId = interaction.options.getInteger("obra");
          return obraId === null ? null : String(obraId);
        })() ??
        null,
    });

    try {
      await command.execute(interaction);
      logger.info(
        {
          command: interaction.commandName,
          guildId: interaction.guildId,
          handlerDurationMs: Date.now() - receivedAt,
        },
        "Comando executado com sucesso",
      );
    } catch (err) {
      const callbackUnavailable = isInteractionCallbackUnavailable(err);
      if (callbackUnavailable) {
        logger.warn(
          {
            command: interaction.commandName,
            cooldownRemainingMs: interactionCallbackCooldownRemaining(),
          },
          "Comando não respondeu durante rate limit de callbacks do Discord",
        );
      } else {
        logger.error({ err, command: interaction.commandName }, "Erro ao executar comando");
        void recordBotError({
          source: "command",
          errorCode: "COMMAND_EXECUTION_FAILED",
          error: err,
          discordGuildId: interaction.guildId,
          discordUserId: interaction.user.id,
          command: interaction.commandName,
        });
      }
      const msg = { content: "❌ Ocorreu um erro ao executar esse comando.", ephemeral: true };
      if (callbackUnavailable) {
        logger.debug(
          { command: interaction.commandName },
          "Resposta de erro suprimida durante rate limit de callbacks",
        );
      } else if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg).catch((followUpError) => {
          logger.warn(
            { err: followUpError, command: interaction.commandName },
            "Falha ao enviar erro após resposta deferida",
          );
        });
      } else if (!initialResponseAttempted) {
        await interaction.reply(msg).catch((replyError) => {
          logger.warn(
            { err: replyError, command: interaction.commandName },
            "Falha ao enviar resposta de erro do comando",
          );
        });
      } else {
        logger.warn(
          { command: interaction.commandName },
          "Resposta inicial já tentada; callback de erro não será repetido",
        );
      }
    }
  });
}