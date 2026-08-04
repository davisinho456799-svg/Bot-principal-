import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
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
    .limit(15);

  if (rows.length === 0) {
    await interaction.editReply("✅ Nenhum erro registrado no histórico.");
    return;
  }

  const lines = rows.map((row) => {
    const when = new Date(row.createdAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    const command = row.command ? ` \`/${row.command}\`` : "";
    const guild = row.discordGuildId ? ` • servidor \`${row.discordGuildId}\`` : "";
    return (
      `\`${when}\` **${row.errorCode}** — ${row.message.slice(0, 180)}` +
      `\n↳ origem: \`${row.source}\`${command}${guild} • ID \`${row.id}\``
    );
  });

  const embed = new EmbedBuilder()
    .setTitle(`🧾 Histórico de erros — ${rows.length} registro(s)`)
    .setDescription(lines.join("\n\n").slice(0, 4096))
    .setColor(0xe74c3c)
    .setFooter({ text: "Retenção automática: 30 dias • máximo de 500 por servidor" });

  await interaction.editReply({ embeds: [embed] });
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
    if (!ch || !(ch instanceof TextChannel)) {
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

    await ch.send({ embeds: [embed] });

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
    await runCheck(client);

    const doneEmbed = new EmbedBuilder()
      .setTitle("✅ Verificação Concluída")
      .setColor(0x2ecc71)
      .setDescription(
        "A verificação manual terminou com sucesso.\n\n" +
        "> Se havia atualizações, as notificações já foram enviadas.\n" +
        "> Se não chegou nada, é porque não há novidades desde a última checagem."
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
