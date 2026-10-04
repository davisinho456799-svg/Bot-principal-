import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  monitorConfigTable,
  monitorHistoryTable,
  monitoredWorksTable,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { runMonitor, runResendNotification, runTestNotification } from "./monitor-service.js";
import { getActiveNumberedMonitorWorks } from "./monitor-work-list.js";
import { resolveMonitorWorkNumber } from "./monitor-work-numbering.js";
import { runMonitorDiagnostic, formatMonitorDiagnostic } from "./monitor-diagnostic.js";
import { MonitorUnavailableError } from "./monitor-execution.js";

export const monitorCommandDefinition = new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Gerencia os manhwas monitorados")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((command) =>
      command
        .setName("adicionar")
        .setDescription("Adiciona um manhwa à monitoração")
        .addStringOption((option) =>
          option
            .setName("link")
            .setDescription("URL pública da obra ou da lista de capítulos")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("nome")
            .setDescription("Nome da obra; se omitido, será obtido do link")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("plataforma")
            .setDescription("Informe apenas se o domínio não identificar a plataforma")
            .addChoices(
              { name: "Lezhin", value: "lezhin" },
              { name: "Toomics", value: "toomics" },
              { name: "Toptoon", value: "toptoon" },
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((command) =>
      command.setName("listar").setDescription("Lista os manhwas ativos"),
    )
    .addSubcommand((command) =>
      command
        .setName("renomear")
        .setDescription("Altera o nome de uma obra monitorada")
        .addIntegerOption((option) =>
          option
            .setName("id")
            .setDescription("Número atual exibido pelo /monitor listar; exige confirmação")
            .setMinValue(1)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("nome")
            .setDescription("Novo nome da obra")
            .setMinLength(1)
            .setMaxLength(200)
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("historico")
        .setDescription("Lista os últimos capítulos enviados ao Discord"),
    )
    .addSubcommand((command) =>
      command
        .setName("reenviar")
        .setDescription("Reenvia um capítulo monitorado, tentando recuperar a imagem")
        .addIntegerOption((option) =>
          option
            .setName("obra")
            .setDescription("Número atual da obra exibido pelo /monitor listar")
            .setMinValue(1)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("capitulo")
            .setDescription("Número do capítulo a reenviar, por exemplo 12 ou 12.5")
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("canal")
        .setDescription("Escolhe o canal que receberá as notificações")
        .addChannelOption((option) =>
          option
            .setName("canal")
            .setDescription("Canal de texto para as notificações")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("verificar").setDescription("Executa uma verificação agora"),
    )
    .addSubcommand((command) =>
      command
        .setName("diagnostico")
        .setDescription("Compara tempos sem enviar notificações ou alterar o agendamento")
        .addIntegerOption((option) =>
          option.setName("obra").setDescription("Número da obra; omita para comparar todas")
            .setMinValue(1).setRequired(false),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("teste")
        .setDescription("Testa uma obra específica ou escolhe uma aleatória")
        .addIntegerOption((option) =>
          option
            .setName("obra")
            .setDescription("Número atual da obra exibido pelo /monitor listar")
            .setMinValue(1)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName("duas_imagens")
            .setDescription("Teste Toptoon: imagens 2 e 3, sem alterar notificações automáticas")
            .setRequired(false),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("remover")
        .setDescription("Remove uma obra da monitoração")
        .addIntegerOption((option) =>
          option
            .setName("id")
            .setDescription("Número atual exibido pelo /monitor listar; exige confirmação")
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("erros").setDescription("Mostra os erros atuais do monitor"),
    )
    .toJSON();

type Platform = "lezhin" | "toomics" | "toptoon";

function detectPlatform(link: string): Platform | null {
  const hostname = new URL(link).hostname.toLowerCase();
  if (hostname.includes("lezhin")) return "lezhin";
  if (hostname.includes("toomics")) return "toomics";
  if (hostname.includes("toptoon")) return "toptoon";
  return null;
}
function titleFromUrl(link: string) {
  const url = new URL(link);
  const slug = decodeURIComponent(url.pathname)
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return slug || url.hostname.replace(/^www\./, "");
}

function normalizeUrl(link: string) {
  const url = new URL(link);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("O link precisa começar com http:// ou https://.");
  }
  return url.toString();
}

async function replyError(interaction: ChatInputCommandInteraction, message: string) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: `❌ ${message}`, components: [] });
  } else {
    await interaction.reply({ content: `❌ ${message}`, ephemeral: true });
  }
}

function formatTestFailure(progress: string[], error: string): string {
  const header = "❌ **Teste não enviado**\n🧭 **Caminho do teste**";
  const footer = `\n\n❌ ${error.slice(0, 500)}`;
  const steps = progress.map((step, index) => `${index + 1}. ${step}`);
  let omitted = false;
  while (steps.length && (header + "\n" + steps.join("\n") + footer).length > 1930) {
    steps.shift();
    omitted = true;
  }
  return [header, ...(omitted ? ["… etapas iniciais omitidas por limite de espaço."] : []), ...steps].join("\n") + footer;
}
async function handleAdd(interaction: ChatInputCommandInteraction) {
  const rawLink = interaction.options.getString("link", true).trim();
  const requestedTitle = interaction.options.getString("nome")?.trim();
  const requestedPlatform = interaction.options.getString("plataforma") as Platform | null;

  let listingUrl: string;
  try {
    listingUrl = normalizeUrl(rawLink);
  } catch (error) {
    await replyError(interaction, error instanceof Error ? error.message : "Link inválido.");
    return;
  }

  const platform = requestedPlatform ?? detectPlatform(listingUrl);
  if (!platform) {
    await replyError(
      interaction,
      "Não consegui identificar a plataforma. Use `plataforma: Lezhin`, `Toomics` ou `Toptoon`.",
    );
    return;
  }

  const [existing] = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.listingUrl, listingUrl))
    .limit(1);
  if (existing) {
    await interaction.editReply({
      content: `ℹ️ **${existing.title}** já está cadastrado como ${existing.active ? "ativo" : "pausado"}.\n${existing.listingUrl}`,
    });
    return;
  }

  const title = requestedTitle || titleFromUrl(listingUrl);
  const [work] = await db
    .insert(monitoredWorksTable)
    .values({ title, platform, listingUrl, active: true })
    .returning();
  const works = await getActiveNumberedMonitorWorks();
  const numberedWork = works.find((candidate) => candidate.id === work.id);

  await interaction.editReply({
    content: [
      `✅ **${work.title}** agora está sendo monitorado.`,
      `Plataforma: ${platform}`,
      `A primeira verificação será feita na próxima rodada e criará a linha de base sem repostar o histórico.`,
      numberedWork
        ? `Número atual da obra: ${numberedWork.displayNumber}`
        : "Consulte /monitor listar para conferir a lista atual.",
    ].join("\n"),
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const works = await getActiveNumberedMonitorWorks();

  if (!works.length) {
    await interaction.editReply({
      content: "Ainda não há manhwas ativos. Use `/monitor adicionar` para cadastrar o primeiro.",
    });
    return;
  }

  const lines = works.map(
    (work) => `• **Nº ${work.displayNumber} — ${work.title}** · ${work.platform}\n  ${work.listingUrl}`,
  );
  await interaction.editReply({
    content: `📚 **Manhwas monitorados (${works.length})**\nOs números mudam ao remover ou reativar obras. Consulte esta lista antes de usar os comandos.\n${lines.join("\n")}`.slice(0, 1900),
  });
}

async function handleSetChannel(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("canal", true);
  if (
    !("isTextBased" in channel) ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased() ||
    !("name" in channel)
  ) {
    await replyError(interaction, "Escolha um canal de texto válido.");
    return;
  }

  const [existing] = await db
    .select({ id: monitorConfigTable.id })
    .from(monitorConfigTable)
    .limit(1);

  if (existing) {
    await db
      .update(monitorConfigTable)
      .set({
        discordChannelId: channel.id,
        discordChannelName: channel.name,
        updatedAt: new Date(),
      })
      .where(eq(monitorConfigTable.id, existing.id));
  } else {
    await db.insert(monitorConfigTable).values({
      id: 1,
      discordChannelId: channel.id,
      discordChannelName: channel.name,
    });
  }

  await interaction.editReply({
    content: [
      "✅ Canal de notificações salvo.",
      `As próximas notificações serão enviadas em <#${channel.id}>.`,
      "Agora você pode usar `/monitor teste` para validar o envio.",
    ].join("\n"),
  });
}

async function handleHistory(interaction: ChatInputCommandInteraction) {
  const history = await db
    .select({
      workTitle: monitoredWorksTable.title,
      chapterNumber: monitorHistoryTable.chapterNumber,
      releaseDate: monitorHistoryTable.releaseDate,
      notifiedAt: monitorHistoryTable.notifiedAt,
    })
    .from(monitorHistoryTable)
    .innerJoin(monitoredWorksTable, eq(monitorHistoryTable.workId, monitoredWorksTable.id))
    .orderBy(desc(monitorHistoryTable.notifiedAt))
    .limit(15);

  if (!history.length) {
    await interaction.editReply({
      content: "📭 Ainda não há capítulos enviados pelo monitor.",
    });
    return;
  }

  const lines = history.map((item) => {
    const notifiedAt = item.notifiedAt.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
    const releaseDate = item.releaseDate ? ` · lançado em ${item.releaseDate}` : "";
    return `• **${item.workTitle}** · capítulo **${item.chapterNumber}** · notificado em ${notifiedAt}${releaseDate}`;
  });
  const suffix = history.length === 15 ? "\n\nMostrando os 15 mais recentes." : "";
  await interaction.editReply({
    content: [`📚 **Histórico de notificações**`, ...lines, suffix].join("\n").slice(0, 1950),
  });
}

export async function executeManhwaCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "adicionar") {
    await handleAdd(interaction);
    return;
  }
  if (subcommand === "listar") {
    await handleList(interaction);
    return;
  }
  if (subcommand === "historico") {
    await handleHistory(interaction);
    return;
  }
  if (subcommand === "reenviar") {
    const workNumber = interaction.options.getInteger("obra", true);
    const work = resolveMonitorWorkNumber(await getActiveNumberedMonitorWorks(), workNumber);
    if (!work) {
      await replyError(interaction, `Não encontrei a obra nº ${workNumber}. Use /monitor listar para conferir a numeração atual.`);
      return;
    }
    const chapterNumber = interaction.options.getString("capitulo", true);
    const progress: string[] = [];
    const updateProgress = async (message: string) => {
      progress.push(message);
      await interaction.editReply({
        content: [
          "🔁 **Reenvio do capítulo**",
          ...progress.map((step, index) => `${index + 1}. ${step}`),
        ].join("\n"),
      });
    };

    try {
      const result = await runResendNotification(work.id, chapterNumber, updateProgress);
      await interaction.editReply({
        content: [
          "✅ **Capítulo reenviado**",
          `Obra: **${result.title}**`,
          `Capítulo: **${result.chapter}**`,
          `Imagem: **${result.imageMode === "none" ? "indisponível" : result.imageMode}**`,
          `Parser: **${result.parser}**`,
        ].join("\n"),
      });
    } catch (error) {
      await replyError(
        interaction,
        error instanceof Error ? error.message : "Não foi possível reenviar o capítulo.",
      );
    }
    return;
  }
  if (subcommand === "canal") {
    await handleSetChannel(interaction);
    return;
  }
  if (subcommand === "verificar") {
    const result = await runMonitor();
    await interaction.editReply({
      content: [
        "✅ Verificação concluída.",
        `Obras verificadas: ${result.worksChecked}`,
        `Capítulos novos encontrados: ${result.chaptersFound}`,
        `Publicações enviadas: ${result.postsSent}`,
      ].join("\n"),
    });
    return;
  }
  if (subcommand === "diagnostico") {
    try {
      const number = interaction.options.getInteger("obra") ?? undefined;
      const work = number === undefined ? undefined
        : resolveMonitorWorkNumber(await getActiveNumberedMonitorWorks(), number);
      if (number !== undefined && !work) {
        await replyError(interaction, "Obra não encontrada. Confira a numeração em /monitor listar.");
        return;
      }
      await interaction.editReply({ content: "Medindo consulta e captura, sem enviar notificações nem alterar o agendamento. A verificação normal tem prioridade." });
      const report = await runMonitorDiagnostic(work?.id);
      const content = formatMonitorDiagnostic(report);
      await interaction.editReply(content.length <= 1950
        ? { content, allowedMentions: { parse: [] } }
        : { content: `Diagnóstico concluído. ${report.results.length} obras medidas; ${report.worksSkipped} não verificadas. Comparação completa no arquivo.`, files: [{ attachment: Buffer.from(content), name: "tempos-diagnostico.txt" }], allowedMentions: { parse: [] } });
    } catch (error) {
      logger.warn({ errorName: error instanceof Error ? error.name : "Error" }, "Diagnóstico do monitor indisponível");
      await replyError(interaction, error instanceof MonitorUnavailableError
        ? error.message : "Não foi possível executar o diagnóstico. Nenhuma notificação foi enviada.");
    }
    return;
  }
  if (subcommand === "teste") {
    const workNumber = interaction.options.getInteger("obra") ?? undefined;
    const works = workNumber === undefined ? undefined : await getActiveNumberedMonitorWorks();
    const work = works && resolveMonitorWorkNumber(works, workNumber!);
    if (workNumber !== undefined && !work) {
      await replyError(interaction, `Não encontrei a obra nº ${workNumber}. Use /monitor listar para conferir a numeração atual.`);
      return;
    }
    const progress: string[] = [];
    const updateProgress = async (message: string) => {
      progress.push(message);
      await interaction.editReply({
        content: [
          "🧭 **Caminho do teste**",
          ...progress.map((step, index) => `${index + 1}. ${step}`),
        ].join("\n"),
      });
    };

    try {
      const result = await runTestNotification(updateProgress, work?.id, interaction.options.getBoolean("duas_imagens") ?? false);
      await interaction.editReply({
        content: [
          "✅ **Resultado do teste**",
          ...progress.map((step, index) => `${index + 1}. ${step}`),
          "",
          "🧪 Notificação de teste enviada no canal do monitor.",
          `Título escolhido: **${result.title}**`,
          `Capítulo/imagem: ${result.chapter}`,
          `Parser usado: ${result.parser}`,
          `Modo da captura: ${result.captureMode}`,
          ...(result.imageSelection ? [`Imagem usada: ${result.imageSelection === "extras" ? "duas extras (2 e 3)" : result.imageSelection === "text" ? "somente texto; nenhuma imagem disponível" : result.captureMode === "primary+banner" ? "principal do mesmo capítulo (reserva)" : "principal"}.`] : []),
        ].join("\n"),
      });
    } catch (error) {
      await interaction.editReply({
        content: formatTestFailure(progress, error instanceof Error ? error.message : "Não foi possível enviar a notificação de teste."),
        components: [],
      });
    }
    return;
  }
  if (subcommand === "remover" || subcommand === "renomear") {
    const workNumber = interaction.options.getInteger("id", true);
    const selected = resolveMonitorWorkNumber(await getActiveNumberedMonitorWorks(), workNumber);
    if (!selected) {
      await replyError(interaction, `Não encontrei a obra nº ${workNumber}. Use /monitor listar para conferir a numeração atual.`);
      return;
    }
    const renaming = subcommand === "renomear";
    const title = renaming ? interaction.options.getString("nome", true).trim() : undefined;
    if (renaming && !title) {
      await replyError(interaction, "Informe um nome não vazio para a obra.");
      return;
    }
    // Bind confirmation to an immutable ID, never re-resolve a changing number.
    const confirmId = `monitor-${subcommand}:${interaction.id}:${selected.id}`;
    const cancelId = `monitor-cancel:${interaction.id}`;
    const question = renaming
      ? `Renomear **${selected.title}** (nº ${selected.displayNumber}) para **${title}**?`
      : `Remover **${selected.title}** (nº ${selected.displayNumber}) da monitoração?`;
    const message = await interaction.editReply({
      content: `${question}\n${selected.listingUrl}\nConfira o título: a numeração pode ter mudado desde a última listagem. O histórico será preservado.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(confirmId).setLabel(renaming ? "Confirmar renomeação" : "Confirmar remoção").setStyle(renaming ? ButtonStyle.Primary : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cancelId).setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    let button;
    try {
      button = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 60_000,
        filter: (candidate) =>
          candidate.user.id === interaction.user.id &&
          [confirmId, cancelId].includes(candidate.customId),
      });
    } catch (error) {
      logger.warn({ err: error, workId: selected.id }, "Confirmação de alteração do monitor não concluída");
      await interaction.editReply({
        content: "Confirmação não concluída. Nenhuma obra foi alterada. Use /monitor listar antes de tentar novamente.",
        components: [],
      });
      return;
    }
    await button.deferUpdate();
    if (button.customId === cancelId) {
      await interaction.editReply({ content: "Operação cancelada. Nenhuma obra foi alterada.", components: [] });
      return;
    }
    const [changed] = await db
      .update(monitoredWorksTable)
      .set(renaming ? { title, updatedAt: new Date() } : { active: false, updatedAt: new Date() })
      .where(and(eq(monitoredWorksTable.id, selected.id), eq(monitoredWorksTable.active, true)))
      .returning();

    if (!changed) {
      await interaction.editReply({
        content: "Essa obra já foi removida ou pausada. Nenhuma outra obra foi alterada. Consulte /monitor listar.",
        components: [],
      });
      return;
    }

    await interaction.editReply({
      content: [
        renaming
          ? `✅ Obra nº ${selected.displayNumber} renomeada para **${changed.title}**.`
          : `🗑️ **${changed.title}** foi removido da monitoração.`,
        "A URL, a plataforma e o histórico de capítulos foram preservados.",
        renaming ? "" : "A numeração foi reorganizada. Use /monitor listar antes de selecionar outra obra.",
      ].join("\n"),
      components: [],
    });
    return;
  }
  if (subcommand === "erros") {
    const works = await getActiveNumberedMonitorWorks();
    const failedWorks = works.filter((work) => work.lastStatus?.startsWith("Check failed"));

    if (!failedWorks.length) {
      await interaction.editReply({
        content: "✅ Nenhuma obra está com erro no momento.",
      });
      return;
    }

    const lines = failedWorks.map((work) => [
      `• **${work.title}** · Nº ${work.displayNumber}`,
      `  ${work.lastStatus}`,
      `  Última tentativa: ${work.lastCheckedAt?.toISOString() ?? "desconhecida"}`,
    ].join("\n"));
    await interaction.editReply({
      content: `⚠️ **Erros atuais do monitor (${failedWorks.length})**\n${lines.join("\n")}`.slice(0, 1900),
    });
  }
}
