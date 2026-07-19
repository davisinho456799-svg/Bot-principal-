import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  adminUsersTable,
  usageLogsTable,
} from "@workspace/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { requireAdmin } from "../admin-guard.js";

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
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // Qualquer subcomando exceto promover requer ser admin
  if (sub !== "promover" || (await isFirstAdmin())) {
    const allowed = await requireAdmin(interaction);
    if (!allowed) return;
  }

  await interaction.deferReply({ ephemeral: true });

  switch (sub) {
    case "logs":
      await handleLogs(interaction);
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
