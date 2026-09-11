import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import {
  db,
  assinaturasTable,
  releasePreferencesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  createPanelWatchEmbed,
  PANEL_WATCH_COLORS,
  setPanelWatchFooter,
} from "../identity.js";

type PreferenceRow = typeof releasePreferencesTable.$inferSelect;
type QueryRow = Record<string, unknown>;

function rowsOf(result: unknown): QueryRow[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows.filter((row): row is QueryRow => !!row && typeof row === "object") : [];
}

async function ensurePreferences(userId: string): Promise<PreferenceRow> {
  await db
    .insert(releasePreferencesTable)
    .values({ discordUserId: userId })
    .onConflictDoNothing();

  const [preferences] = await db
    .select()
    .from(releasePreferencesTable)
    .where(eq(releasePreferencesTable.discordUserId, userId));

  return preferences ?? {
    discordUserId: userId,
    notificationsEnabled: true,
    adultEnabled: false,
    digestMode: "imediato",
    updatedAt: new Date(),
  };
}

function formatDate(value: unknown): string {
  if (!value) return "data desconhecida";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "data desconhecida";
  return date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
}

async function fetchRecentHistory(userId: string, guildId: string, adultEnabled: boolean) {
  const result = await db.execute(sql`
    SELECT
      e.title,
      MAX(e.chapter) AS chapter,
      MAX(e.sent_at) AS sent_at,
      MAX(a.site_url) AS site_url
    FROM notificacao_eventos e
    INNER JOIN assinaturas a
      ON lower(a.title) = lower(e.title)
    WHERE a.discord_user_id = ${userId}
      AND a.guild_id = ${guildId}
      AND e.sent_at IS NOT NULL
      AND e.sent_at >= now() - interval '30 days'
      AND (${adultEnabled} OR COALESCE(a.adult, false) = false)
    GROUP BY e.title
    ORDER BY MAX(e.sent_at) DESC
    LIMIT 8
  `);

  return rowsOf(result);
}

async function fetchRecommendations(userId: string, guildId: string, adultEnabled: boolean) {
  const result = await db.execute(sql`
    SELECT
      f.title,
      MAX(f.site_url) AS site_url,
      MAX(f.cover_url) AS cover_url,
      COUNT(DISTINCT f.discord_user_id)::int AS popularity
    FROM favoritos f
    WHERE f.discord_user_id <> ${userId}
      AND NOT EXISTS (
        SELECT 1
        FROM assinaturas a
        WHERE a.discord_user_id = ${userId}
          AND a.guild_id = ${guildId}
          AND lower(a.title) = lower(f.title)
      )
      AND (
        ${adultEnabled}
        OR NOT EXISTS (
          SELECT 1
          FROM assinaturas adult_source
          WHERE lower(adult_source.title) = lower(f.title)
            AND adult_source.adult = true
        )
      )
    GROUP BY f.title
    ORDER BY COUNT(DISTINCT f.discord_user_id) DESC, MAX(f.added_at) DESC
    LIMIT 5
  `);

  return rowsOf(result);
}

async function fetchSubscriptionCount(userId: string, guildId: string, adultEnabled: boolean) {
  const [result] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(assinaturasTable)
    .where(and(
      eq(assinaturasTable.discordUserId, userId),
      eq(assinaturasTable.guildId, guildId),
      adultEnabled ? undefined : eq(assinaturasTable.adult, false),
    ));

  return result?.total ?? 0;
}

async function handleInicio(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.editReply("❌ A central personalizada só pode ser usada em servidores.");
    return;
  }

  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const preferences = await ensurePreferences(userId);
  const [history, recommendations, subscriptions] = await Promise.all([
    fetchRecentHistory(userId, guildId, preferences.adultEnabled),
    fetchRecommendations(userId, guildId, preferences.adultEnabled),
    fetchSubscriptionCount(userId, guildId, preferences.adultEnabled),
  ]);

  const embed = createPanelWatchEmbed(
    preferences.adultEnabled ? PANEL_WATCH_COLORS.adult : PANEL_WATCH_COLORS.primary,
  )
    .setTitle(`🧭 Central Panel Watch · ${interaction.user.displayName}`)
    .setDescription(
      `${preferences.adultEnabled ? "🔞 Modo +18 ativado" : "🛡️ Modo seguro ativado"}\n` +
      `🔔 Notificações: **${preferences.notificationsEnabled ? "ativadas" : "desativadas"}** ` +
      `(${preferences.digestMode})\n` +
      `📚 **${subscriptions}** assinatura(s) consideradas nesta central.`,
    )
  setPanelWatchFooter(embed, "Central personalizada • Use /central preferencias");

  const historyLines = history.map((row) =>
    `• **${String(row.title)}** — cap. **${String(row.chapter)}** · ${formatDate(row.sent_at)}`,
  );
  embed.addFields({
    name: "🆕 Seus lançamentos recentes",
    value: historyLines.length ? historyLines.join("\n") : "Nenhum lançamento recente encontrado.",
    inline: false,
  });

  const recommendationLines = recommendations.map((row) =>
    `• [${String(row.title)}](${String(row.site_url)}) · ${String(row.popularity)} usuário(s) acompanham`,
  );
  embed.addFields({
    name: "✨ Recomendações para você",
    value: recommendationLines.length
      ? recommendationLines.join("\n")
      : "Adicione favoritos para receber recomendações personalizadas.",
    inline: false,
  });

  await interaction.editReply({ embeds: [embed] });
}

async function handleHistorico(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.editReply("❌ O histórico só pode ser usado em servidores.");
    return;
  }

  const preferences = await ensurePreferences(interaction.user.id);
  const history = await fetchRecentHistory(
    interaction.user.id,
    interaction.guildId,
    preferences.adultEnabled,
  );
  const lines = history.map((row, index) =>
    `**${index + 1}.** [${String(row.title)}](${String(row.site_url ?? "")}) — ` +
    `cap. **${String(row.chapter)}** · ${formatDate(row.sent_at)}`,
  );

  const embed = createPanelWatchEmbed(PANEL_WATCH_COLORS.status)
    .setTitle("🕘 Histórico de lançamentos")
    .setDescription(lines.length ? lines.join("\n") : "Nenhum lançamento recebido nos últimos 30 dias.");
  setPanelWatchFooter(embed, "Histórico • Últimos 30 dias");

  await interaction.editReply({ embeds: [embed] });
}

async function handleRecomendacoes(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.editReply("❌ As recomendações só podem ser usadas em servidores.");
    return;
  }

  const preferences = await ensurePreferences(interaction.user.id);
  const recommendations = await fetchRecommendations(
    interaction.user.id,
    interaction.guildId,
    preferences.adultEnabled,
  );
  const lines = recommendations.map((row, index) =>
    `**${index + 1}.** [${String(row.title)}](${String(row.site_url)}) — ` +
    `acompanhado por **${String(row.popularity)}** usuário(s)`,
  );

  await interaction.editReply({
    embeds: [
      createPanelWatchEmbed(preferences.adultEnabled ? PANEL_WATCH_COLORS.adult : PANEL_WATCH_COLORS.manhwa)
        .setTitle("✨ Recomendações personalizadas")
        .setDescription(lines.length ? lines.join("\n") : "Adicione favoritos para melhorar suas recomendações.")
        .setFooter({ text: "Panel Watch • Recomendações da comunidade" }),
    ],
  });
}

async function handlePreferencias(interaction: ChatInputCommandInteraction) {
  const current = await ensurePreferences(interaction.user.id);
  const notifications = interaction.options.getString("notificacoes");
  const adult = interaction.options.getString("adulto");
  const mode = interaction.options.getString("modo");

  if (notifications || adult || mode) {
    await db
      .update(releasePreferencesTable)
      .set({
        notificationsEnabled: notifications ? notifications === "ativadas" : current.notificationsEnabled,
        adultEnabled: adult ? adult === "mostrar" : current.adultEnabled,
        digestMode: mode ?? current.digestMode,
        updatedAt: new Date(),
      })
      .where(eq(releasePreferencesTable.discordUserId, interaction.user.id));
  }

  const preferences = notifications || adult || mode
    ? await ensurePreferences(interaction.user.id)
    : current;

  await interaction.editReply({
    embeds: [
      createPanelWatchEmbed(
        preferences.adultEnabled ? PANEL_WATCH_COLORS.adult : PANEL_WATCH_COLORS.primary,
      )
        .setTitle("⚙️ Preferências da central")
        .setDescription(
          `🔔 Notificações: **${preferences.notificationsEnabled ? "ativadas" : "desativadas"}**\n` +
          `📬 Entrega: **${preferences.digestMode}**\n` +
          `🔞 Conteúdo +18: **${preferences.adultEnabled ? "visível" : "oculto"}**`,
        )
        .setFooter({ text: "Panel Watch • Preferências da central" }),
    ],
  });
}

export const data = new SlashCommandBuilder()
  .setName("central")
  .setDescription("Sua central personalizada de lançamentos e recomendações")
  .addSubcommand((sub) =>
    sub.setName("inicio").setDescription("Mostra lançamentos, histórico e recomendações"),
  )
  .addSubcommand((sub) =>
    sub.setName("historico").setDescription("Mostra seus lançamentos recentes"),
  )
  .addSubcommand((sub) =>
    sub.setName("recomendacoes").setDescription("Mostra recomendações personalizadas"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("preferencias")
      .setDescription("Configura notificações e visibilidade de conteúdo +18")
      .addStringOption((option) =>
        option
          .setName("notificacoes")
          .setDescription("Receber notificações automáticas")
          .addChoices(
            { name: "Ativadas", value: "ativadas" },
            { name: "Desativadas", value: "desativadas" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("adulto")
          .setDescription("Mostrar conteúdo +18 na central")
          .addChoices(
            { name: "Mostrar +18", value: "mostrar" },
            { name: "Ocultar +18", value: "ocultar" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("modo")
          .setDescription("Como deseja receber lançamentos")
          .addChoices(
            { name: "Imediato", value: "imediato" },
            { name: "Resumo semanal", value: "semanal" },
          ),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  switch (interaction.options.getSubcommand()) {
    case "inicio":
      await handleInicio(interaction);
      return;
    case "historico":
      await handleHistorico(interaction);
      return;
    case "recomendacoes":
      await handleRecomendacoes(interaction);
      return;
    case "preferencias":
      await handlePreferencias(interaction);
      return;
    default:
      await interaction.editReply("❌ Subcomando da central não reconhecido.");
  }
}