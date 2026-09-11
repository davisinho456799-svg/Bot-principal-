import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  db,
  notificacaoCanaisTable,
  adminUsersTable,
  usageLogsTable,
  errorLogsTable,
} from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireAdmin } from "../admin-guard.js";
import { runCheck } from "../notificacao-service.js";
import { extractHttpStatus } from "../error-log.js";

const ERROR_PAGE_SIZE = 5;
const ERROR_PAGE_TIME = 15 * 60 * 1000;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const ERROR_ROW_DESCRIPTION_LIMIT = 640;
const ERROR_CONTEXT_VALUE_LIMIT = 180;

export type ErrorRow = typeof errorLogsTable.$inferSelect;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return value.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

function contextValue(row: ErrorRow, key: string): string | null {
  const value = row.context?.[key];
  return typeof value === "string" || typeof value === "number"
    ? truncateText(String(value), ERROR_CONTEXT_VALUE_LIMIT)
    : null;
}

function sourceLabel(source: string | null): string {
  const labels: Record<string, string> = {
    "anilist-anime": "AniList Anime",
    anilist: "AniList",
    comick: "Comick",
    mangadex: "MangaDex",
    mangaupdates: "MangaUpdates",
    jikan: "Jikan",
    notification_source: "fonte de notificação",
    notification: "envio de notificação",
  };
  return source ? truncateText(labels[source] ?? source, ERROR_CONTEXT_VALUE_LIMIT) : "desconhecida";
}

export function describeErrorRow(row: ErrorRow): string {
  const attemptedSource = contextValue(row, "attemptedSource");
  const source = contextValue(row, "source") ?? attemptedSource;
  const title = contextValue(row, "title");
  const channelId = contextValue(row, "channelId");
  const httpStatus = row.httpStatus ?? extractHttpStatus(row.message);

  if (row.errorCode.startsWith("SOURCE_HTTP_")) {
    return `🌐 **Fonte recusou a consulta:** ${sourceLabel(source)}${httpStatus ? ` — HTTP \`${httpStatus}\`` : ""}${title ? `\n↳ obra: **${title}**` : ""}`;
  }
  if (row.errorCode === "SOURCE_NO_DATA") {
    return `🔎 **Fonte não retornou dados:** ${sourceLabel(source)}${title ? `\n↳ obra: **${title}**` : ""}`;
  }
  if (row.errorCode.includes("NOTIFICATION") || row.errorCode.includes("STATUS_NOTIFICATION")) {
    return `📤 **Falha ao enviar notificação:** ${title ? `**${title}**` : "obra não identificada"}${source ? `\n↳ fonte: ${sourceLabel(source)}` : ""}${channelId ? ` • canal \`${channelId}\`` : ""}`;
  }
  if (row.errorCode.includes("DATABASE") || row.errorCode.includes("SUBSCRIPTION_")) {
    return `🗄️ **Falha no banco ao processar assinatura:** ${row.command ? `\`/${row.command}\`` : "comando não identificado"}`;
  }
  if (row.errorCode === "TITLE_CHECK_FAILED") {
    return `⚙️ **Falha ao verificar obra:** ${title ? `**${title}**` : "obra não identificada"}${source ? ` • fonte: ${sourceLabel(source)}` : ""}`;
  }

  const message = row.message.replace(/\s+/g, " ").slice(0, 220);
  return `⚠️ **${truncateText(row.errorCode, ERROR_CONTEXT_VALUE_LIMIT)}** — ${message}`;
}

export function clampErrorPage(page: number, totalPages: number): number {
  const lastPage = Math.max(0, totalPages - 1);
  return Math.min(lastPage, Math.max(0, Number.isInteger(page) ? page : 0));
}

export function buildErrorEmbed(
  rows: ErrorRow[],
  page: number,
  totalPages: number,
  guildId: string | null,
): EmbedBuilder {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampErrorPage(page, safeTotalPages);
  const start = safePage * ERROR_PAGE_SIZE;
  const pageRows = rows.slice(start, start + ERROR_PAGE_SIZE);
  const lines = pageRows.map((row) => {
    const when = new Date(row.createdAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    const location = row.discordGuildId
      ? `servidor \`${truncateText(row.discordGuildId, ERROR_CONTEXT_VALUE_LIMIT)}\``
      : "servidor não informado";
    const command = row.command
      ? ` • \`/${truncateText(row.command, ERROR_CONTEXT_VALUE_LIMIT)}\``
      : "";
    return `\`${when}\`\n${describeErrorRow(row)}\n↳ ${location}${command} • registro \`${row.id}\``;
  });

  const statusCounts = new Map<string, number>();
  for (const row of rows) {
    const status = row.httpStatus ?? extractHttpStatus(row.message);
    const bucket = status ? `HTTP ${status}` : row.errorCode;
    statusCounts.set(bucket, (statusCounts.get(bucket) ?? 0) + 1);
  }
  const summary = [...statusCounts.entries()]
    .slice(0, 6)
    .map(([label, count]) => `**${truncateText(label, ERROR_CONTEXT_VALUE_LIMIT)}:** ${count}`)
    .join(" • ");
  const header = (
    `**Total:** ${rows.length} registro(s)${guildId ? ` • servidor filtrado: \`${truncateText(guildId, ERROR_CONTEXT_VALUE_LIMIT)}\`` : ""}\n` +
    truncateText(summary || "Nenhuma classificação disponível", 640)
  );
  const rowBudget =
    pageRows.length > 0
      ? Math.max(
          1,
          Math.floor(
            (DISCORD_EMBED_DESCRIPTION_LIMIT - header.length - pageRows.length * 2) /
              pageRows.length,
          ),
        )
      : 0;
  const description = pageRows.length
    ? `${header}\n\n${lines.map((line) => truncateText(line, Math.min(ERROR_ROW_DESCRIPTION_LIMIT, rowBudget))).join("\n\n")}`
    : header;

  return new EmbedBuilder()
    .setTitle(`🧾 Erros de notificações — página ${safePage + 1}/${safeTotalPages}`)
    .setDescription(description)
    .setColor(0xe74c3c)
    .setFooter({ text: "Retenção automática: 30 dias • Use «Ir para página» para navegar" });
}

export function buildErrorPageButtons(
  page: number,
  totalPages: number,
  disabled = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const safeTotalPages = Math.max(1, totalPages);
  if (safeTotalPages <= 1) return [];
  const safePage = clampErrorPage(page, safeTotalPages);

  const buttons: ButtonBuilder[] = [];
  if (safePage > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("admin_errors_prev")
        .setLabel("⬅️ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId("admin_errors_jump")
      .setLabel("⏩ Ir para página")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
  if (safePage < safeTotalPages - 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("admin_errors_next")
        .setLabel("Próxima ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

export const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Comandos administrativos do bot (apenas admins)")
  .addSubcommand((sub) =>
    sub
      .setName("logs")
      .setDescription("Ver últimas pesquisas e comandos usados")
      .addStringOption((opt) =>
        opt
          .setName("usuario_id")
          .setDescription("Filtrar por ID do usuário Discord")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("erros")
      .setDescription("Ver erros recentes do bot e do serviço de notificações")
      .addStringOption((opt) =>
        opt
          .setName("guild_id")
          .setDescription("Filtrar pelo ID de um servidor Discord")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("usuarios")
      .setDescription("Ver usuários mais ativos")
  )
  .addSubcommand((sub) =>
    sub
      .setName("promover")
      .setDescription("Dar permissão de admin a um usuário do Discord")
      .addStringOption((opt) =>
        opt
          .setName("usuario_id")
          .setDescription("ID do usuário no Discord")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("username")
          .setDescription("Nome de usuário do Discord")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("rebaixar")
      .setDescription("Remover permissão de admin de um usuário")
      .addStringOption((opt) =>
        opt
          .setName("usuario_id")
          .setDescription("ID do usuário no Discord")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("admins")
      .setDescription("Ver lista de admins do bot")
  )
  .addSubcommand((sub) =>
    sub
      .setName("testar-notificacoes")
      .setDescription("Dispara a verificação de notificações agora (sem esperar 2h)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("ping-notificacao")
      .setDescription("Envia uma notificação falsa no canal configurado para confirmar que está funcionando")
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // Qualquer subcomando exceto promover requer ser admin
  // handlePromover tem sua própria verificação interna (isFirstAdmin)
  if (sub !== "promover") {
    const allowed = await requireAdmin(interaction);
    if (!allowed) return;
  }

  await interaction.deferReply({ ephemeral: true });

  switch (sub) {
    case "logs":
      await handleLogs(interaction);
      break;
    case "erros":
      await handleErros(interaction);
      break;
    case "usuarios":
      await handleUsuarios(interaction);
      break;
    case "promover":
      await handlePromover(interaction);
      break;
    case "rebaixar":
      await handleRebaixar(interaction);
      break;
    case "admins":
      await handleAdmins(interaction);
      break;
    case "testar-notificacoes":
      await handleTestarNotificacoes(interaction);
      break;
    case "ping-notificacao":
      await handlePingNotificacao(interaction);
      break;
  }
}

// ─── Se não há nenhum admin ainda, qualquer um pode usar /admin promover ──────

async function isFirstAdmin(): Promise<boolean> {
  const result = await db.select().from(adminUsersTable).limit(1);
  return result.length === 0;
}

// ─── Subcomandos ──────────────────────────────────────────────────────────────

async function handleLogs(interaction: ChatInputCommandInteraction) {
  const userId = interaction.options.getString("usuario_id");

  const rows = userId
    ? await db
        .select()
        .from(usageLogsTable)
        .where(eq(usageLogsTable.discordUserId, userId))
        .orderBy(desc(usageLogsTable.createdAt))
        .limit(20)
    : await db
        .select()
        .from(usageLogsTable)
        .orderBy(desc(usageLogsTable.createdAt))
        .limit(20);

  if (rows.length === 0) {
    await interaction.editReply("📭 Nenhum log encontrado.");
    return;
  }

  const lines = rows.map((r) => {
    const hora = new Date(r.createdAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const query = r.query ? ` — \`${r.query.slice(0, 40)}\`` : "";
    return `\`${hora}\` **${r.discordUsername}** → \`/${r.command}\`${query}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📋 Últimos ${rows.length} logs${userId ? ` (usuário ${userId})` : ""}`)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2);

  await interaction.editReply({ embeds: [embed] });
}

async function handleErros(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.options.getString("guild_id");
  const conditions = guildId
    ? [eq(errorLogsTable.discordGuildId, guildId)]
    : [];
  const rows = await db
    .select()
    .from(errorLogsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(errorLogsTable.createdAt))
    .limit(100);

  if (rows.length === 0) {
    await interaction.editReply("✅ Nenhum erro registrado no histórico.");
    return;
  }

  const totalPages = Math.ceil(rows.length / ERROR_PAGE_SIZE);
  let currentPage = 0;
  const pagePayload = (page: number, disabled = false) => ({
    embeds: [buildErrorEmbed(rows, page, totalPages, guildId)],
    components: buildErrorPageButtons(page, totalPages, disabled),
  });

  const message = await interaction.editReply(pagePayload(currentPage));
  if (totalPages <= 1) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: ERROR_PAGE_TIME,
  });

  collector.on("collect", async (button) => {
    if (button.user.id !== interaction.user.id) {
      await button.reply({
        content: "❌ Apenas o administrador que abriu este histórico pode navegar nele.",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (button.customId === "admin_errors_jump") {
      const modal = new ModalBuilder()
        .setCustomId(`admin_errors_jump_modal_${interaction.id}`)
        .setTitle("Ir para página");
      const pageInput = new TextInputBuilder()
        .setCustomId("page")
        .setLabel(`Página desejada (1-${totalPages})`)
        .setPlaceholder(`Digite um número de 1 a ${totalPages}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(pageInput));

      try {
        await button.showModal(modal);
        const submitted = await button.awaitModalSubmit({
          time: 60_000,
          filter: (modalInteraction) =>
            modalInteraction.customId === `admin_errors_jump_modal_${interaction.id}` &&
            modalInteraction.user.id === interaction.user.id,
        });
        const requestedPage = Number(submitted.fields.getTextInputValue("page"));
        if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > totalPages) {
          await submitted.reply({
            content: `❌ Digite uma página entre 1 e ${totalPages}.`,
            ephemeral: true,
          });
          return;
        }
        currentPage = requestedPage - 1;
        await submitted.deferUpdate();
        await interaction.editReply(pagePayload(currentPage));
      } catch (err) {
        // O usuário pode fechar o modal ou o Discord pode expirar a interação.
        if (err instanceof Error && !err.message.includes("time")) {
          console.warn("Erro ao navegar no histórico de erros", err);
        }
      }
      return;
    }

    if (button.customId === "admin_errors_prev") {
      currentPage = Math.max(0, currentPage - 1);
    } else if (button.customId === "admin_errors_next") {
      currentPage = Math.min(totalPages - 1, currentPage + 1);
    } else {
      return;
    }

    await button.update(pagePayload(currentPage)).catch(() => {});
  });

  collector.on("end", () => {
    interaction.editReply(pagePayload(currentPage, true)).catch(() => {});
  });
}

async function handleUsuarios(interaction: ChatInputCommandInteraction) {
  const rows = await db
    .select({
      discordUserId: usageLogsTable.discordUserId,
      discordUsername: usageLogsTable.discordUsername,
      total: sql<number>`count(*)::int`,
    })
    .from(usageLogsTable)
    .groupBy(usageLogsTable.discordUserId, usageLogsTable.discordUsername)
    .orderBy(desc(sql`count(*)`))
    .limit(15);

  if (rows.length === 0) {
    await interaction.editReply("📭 Nenhum dado de uso ainda.");
    return;
  }

  const lines = rows.map(
    (r, i) => `**${i + 1}.** ${r.discordUsername} — ${r.total} comandos`
  );

  const embed = new EmbedBuilder()
    .setTitle("👥 Usuários mais ativos")
    .setDescription(lines.join("\n"))
    .setColor(0x57f287);

  await interaction.editReply({ embeds: [embed] });
}

async function handlePromover(interaction: ChatInputCommandInteraction) {
  const targetId = interaction.options.getString("usuario_id", true);
  const username = interaction.options.getString("username", true);

  // Se não há admins, qualquer um pode promover. Caso contrário, só admin.
  const firstAdmin = await isFirstAdmin();
  if (!firstAdmin) {
    const allowed = await requireAdmin(interaction);
    if (!allowed) return;
  }

  const existing = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.discordUserId, targetId))
    .limit(1);

  if (existing.length > 0) {
    await interaction.editReply(`⚠️ **${username}** já é admin do bot.`);
    return;
  }

  await db.insert(adminUsersTable).values({
    discordUserId: targetId,
    discordUsername: username,
    addedBy: interaction.user.id,
  });

  await interaction.editReply(
    `✅ **${username}** agora é admin do bot e pode usar os comandos \`/admin\`.`
  );
}

async function handleRebaixar(interaction: ChatInputCommandInteraction) {
  const targetId = interaction.options.getString("usuario_id", true);

  const deleted = await db
    .delete(adminUsersTable)
    .where(eq(adminUsersTable.discordUserId, targetId))
    .returning();

  if (deleted.length === 0) {
    await interaction.editReply("⚠️ Usuário não encontrado na lista de admins.");
    return;
  }

  await interaction.editReply(
    `✅ **${deleted[0]!.discordUsername}** foi removido dos admins.`
  );
}

async function handleAdmins(interaction: ChatInputCommandInteraction) {
  const rows = await db.select().from(adminUsersTable).orderBy(adminUsersTable.addedAt);

  if (rows.length === 0) {
    await interaction.editReply(
      "📭 Nenhum admin configurado ainda.\nUse `/admin promover` para adicionar o primeiro."
    );
    return;
  }

  const lines = rows.map(
    (r) => `• **${r.discordUsername}** (\`${r.discordUserId}\`)`
  );

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Admins do bot")
    .setDescription(lines.join("\n"))
    .setColor(0xfee75c);

  await interaction.editReply({ embeds: [embed] });
}

// ─── Ping de notificação (teste com notificação falsa) ───────────────────────

const TITULOS_FAKE = [
  { title: "Solo Leveling",        siteUrl: "https://comick.io/comic/solo-leveling",          tipo: "manhwa", cap: 201 },
  { title: "Spy x Family",         siteUrl: "https://mangadex.org/title/spy-x-family",        tipo: "manga",  cap: 112 },
  { title: "Dungeon Meshi",        siteUrl: "https://anilist.co/manga/85221",                  tipo: "manga",  cap: 97  },
  { title: "Jujutsu Kaisen",       siteUrl: "https://mangadex.org/title/jujutsu-kaisen",      tipo: "manga",  cap: 270 },
  { title: "Tower of God",         siteUrl: "https://comick.io/comic/tower-of-god",            tipo: "manhwa", cap: 604 },
];

async function handlePingNotificacao(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.editReply("❌ Este comando só pode ser usado em servidores.");
    return;
  }

  const [canal] = await db
    .select()
    .from(notificacaoCanaisTable)
    .where(eq(notificacaoCanaisTable.guildId, interaction.guildId));

  if (!canal) {
    await interaction.editReply(
      "❌ Nenhum canal de notificações configurado neste servidor.\n" +
      "Use `/notificar canal #canal` primeiro."
    );
    return;
  }

  try {
    const ch = await interaction.client.channels.fetch(canal.channelId);
    if (!ch || typeof (ch as { send?: unknown }).send !== "function") {
      await interaction.editReply(`❌ Não consegui acessar o canal <#${canal.channelId}>. Verifique as permissões do bot.`);
      return;
    }

    const fake = TITULOS_FAKE[Math.floor(Math.random() * TITULOS_FAKE.length)]!;
    const icone = fake.tipo === "anime" ? "📺" : fake.tipo === "manhwa" ? "🇰🇷" : "🇯🇵";

    const embed = new EmbedBuilder()
      .setTitle(`📬 [TESTE] Novo(s) Capítulo(s): ${fake.title}`)
      .setURL(fake.siteUrl)
      .setColor(0x9b59b6)
      .setDescription(
        `${icone} **1** novo capítulo disponível!\n\n` +
        `📖 Total agora: **${fake.cap}** capítulos\n\n` +
        `> ⚠️ Esta é uma **notificação de teste** — nenhum capítulo real foi lançado.`
      )
      .setFooter({ text: "Notificação de teste • /admin ping-notificacao" });

    await (ch as unknown as { send(payload: unknown): Promise<unknown> }).send({
      embeds: [embed],
    });

    await interaction.editReply(
      `✅ Notificação de teste enviada em <#${canal.channelId}>!\n` +
      `Se apareceu lá, o sistema está funcionando corretamente.`
    );
  } catch (err) {
    await interaction.editReply(
      `❌ Falha ao enviar no canal <#${canal.channelId}>.\n` +
      `Verifique se o bot tem permissão de **Enviar Mensagens** e **Embeds** nesse canal.\n\n` +
      `Erro: \`${String(err)}\``
    );
  }
}

// ─── Testar notificações ──────────────────────────────────────────────────────

async function handleTestarNotificacoes(interaction: ChatInputCommandInteraction) {
  const client = interaction.client;

  const startEmbed = new EmbedBuilder()
    .setTitle("🔔 Verificação Manual Iniciada")
    .setColor(0xf39c12)
    .setDescription(
      "O bot está verificando **todos os títulos rastreados** agora.\n\n" +
      "> ⏳ Pode levar alguns instantes dependendo da quantidade de títulos.\n" +
      "> 📣 Se houver novidades, as notificações serão enviadas nos canais configurados."
    );

  await interaction.editReply({ embeds: [startEmbed] });

  try {
    const summary = await runCheck(client, { verifyAllSources: true });

    const sourceLines = summary.attempts.slice(0, 8).map((item) => {
      const attempts = item.attempts
        .map((attempt) => {
          const value = attempt.value != null ? ` (${attempt.value})` : "";
          return `${attempt.status === "ok" ? "✅" : "❌"} ${attempt.source}${value}`;
        })
        .join(" · ");
      const selected = item.selectedSource
        ? ` → usando **${item.selectedSource}**`
        : " → nenhuma fonte retornou dados";
      return `**${item.title.slice(0, 60)}**${selected}\n${attempts}`;
    });

    const doneEmbed = new EmbedBuilder()
      .setTitle("✅ Verificação Concluída")
      .setColor(0x2ecc71)
      .setDescription(
        "A verificação manual terminou com sucesso.\n\n" +
        `> Títulos verificados: **${summary.titlesChecked}**\n` +
        `> Fontes com resposta: **${summary.successfulSources}**\n` +
        `> Sem dados: **${summary.sourcesWithoutData}**\n` +
        `> Fallbacks usados: **${summary.fallbackUsed}**\n` +
        `> Notificações enviadas: **${summary.notificationsSent}**\n\n` +
        (sourceLines.length ? `**Diagnóstico das fontes:**\n${sourceLines.join("\n\n")}` : "Nenhum título rastreado.")
      );

    await interaction.editReply({ embeds: [doneEmbed] });
  } catch (err) {
    const errEmbed = new EmbedBuilder()
      .setTitle("❌ Erro na Verificação")
      .setColor(0xe74c3c)
      .setDescription(`Ocorreu um erro durante a verificação:\n\`\`\`${String(err)}\`\`\``);
    await interaction.editReply({ embeds: [errEmbed] });
  }
}
