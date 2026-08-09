import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { db, assinaturasTable, favoritosTable } from "@workspace/db";
import { and, desc, eq, ilike } from "drizzle-orm";
import { checkTrackedTitle } from "../notificacao-service.js";

const SOURCE_LABELS: Record<string, string> = {
  anilist: "AniList",
  "anilist-anime": "AniList Anime",
  mangadex: "MangaDex",
  comick: "Comick",
  mangaupdates: "MangaUpdates",
  jikan: "MyAnimeList",
  vndb: "VNDB",
  erogamescape: "ErogeScape",
};

const SOURCE_ICONS: Record<string, string> = {
  anilist: "🟣",
  "anilist-anime": "🟣",
  mangadex: "🟠",
  comick: "🟢",
  mangaupdates: "🔵",
  jikan: "🔴",
  vndb: "📖",
  erogamescape: "🔞",
};

const autocompleteCache = new Map<
  string,
  { results: { name: string; value: string }[]; expires: number }
>();
const CACHE_TTL_MS = 30_000;

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function sourceIcon(source: string): string {
  return SOURCE_ICONS[source] ?? "🔎";
}

export const data = new SlashCommandBuilder()
  .setName("verificar")
  .setDescription("Consulta agora se um título acompanhado recebeu capítulos novos")
  .addStringOption((option) =>
    option
      .setName("titulo")
      .setDescription("Título que você favoritou ou acompanha")
      .setRequired(true)
      .setAutocomplete(true),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().trim();
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  const cacheKey = `${interaction.user.id}:${guildId}:${focused.toLowerCase()}`;
  const cached = autocompleteCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    await interaction.respond(cached.results);
    return;
  }

  const pattern = `%${focused}%`;
  const favoriteWhere = focused
    ? and(
        eq(favoritosTable.discordUserId, interaction.user.id),
        ilike(favoritosTable.title, pattern),
      )
    : eq(favoritosTable.discordUserId, interaction.user.id);
  const subscriptionWhere = focused
    ? and(
        eq(assinaturasTable.discordUserId, interaction.user.id),
        eq(assinaturasTable.guildId, guildId),
        ilike(assinaturasTable.title, pattern),
      )
    : and(
        eq(assinaturasTable.discordUserId, interaction.user.id),
        eq(assinaturasTable.guildId, guildId),
      );

  const [favorites, subscriptions] = await Promise.all([
    db
      .select({
        manhwaId: favoritosTable.manhwaId,
        source: favoritosTable.source,
        title: favoritosTable.title,
      })
      .from(favoritosTable)
      .where(favoriteWhere)
      .orderBy(desc(favoritosTable.addedAt))
      .limit(25),
    db
      .select({
        manhwaId: assinaturasTable.manhwaId,
        source: assinaturasTable.source,
        title: assinaturasTable.title,
      })
      .from(assinaturasTable)
      .where(subscriptionWhere)
      .orderBy(desc(assinaturasTable.addedAt))
      .limit(25),
  ]);

  const seen = new Set<string>();
  const results: { name: string; value: string }[] = [];
  for (const item of [...favorites, ...subscriptions]) {
    const value = `${item.source}:${item.manhwaId}`;
    if (seen.has(value)) continue;
    seen.add(value);
    results.push({
      name: `${sourceIcon(item.source)} ${item.title} • ${sourceLabel(item.source)}`.slice(0, 100),
      value,
    });
    if (results.length >= 25) break;
  }

  autocompleteCache.set(cacheKey, {
    results,
    expires: Date.now() + CACHE_TTL_MS,
  });
  await interaction.respond(results);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ Este comando só pode ser usado em servidores.",
      ephemeral: true,
    });
    return;
  }

  const selected = interaction.options.getString("titulo", true);
  const match = /^(anilist|anilist-anime|mangadex|comick|mangaupdates|jikan|vndb|erogamescape):(.+)$/.exec(selected);
  if (!match) {
    await interaction.reply({
      content: "❌ Selecione um título da lista de sugestões.",
      ephemeral: true,
    });
    return;
  }

  const [, source, manhwaId] = match;
  const [favorite, subscription] = await Promise.all([
    db
      .select({ title: favoritosTable.title })
      .from(favoritosTable)
      .where(
        and(
          eq(favoritosTable.discordUserId, interaction.user.id),
          eq(favoritosTable.manhwaId, manhwaId),
          eq(favoritosTable.source, source),
        ),
      )
      .limit(1),
    db
      .select({ title: assinaturasTable.title })
      .from(assinaturasTable)
      .where(
        and(
          eq(assinaturasTable.discordUserId, interaction.user.id),
          eq(assinaturasTable.guildId, interaction.guildId),
          eq(assinaturasTable.manhwaId, manhwaId),
          eq(assinaturasTable.source, source),
        ),
      )
      .limit(1),
  ]);

  const title = favorite[0]?.title ?? subscription[0]?.title;
  if (!title) {
    await interaction.reply({
      content: "❌ Esse título não está nos seus favoritos nem nas suas assinaturas.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await checkTrackedTitle(manhwaId, source, title);
    const consultedSource = result.selectedSource ?? source;
    const embed = new EmbedBuilder()
      .setTitle(`🔎 Verificação: ${title}`.slice(0, 256))
      .setColor(result.currentChapters == null ? 0xe67e22 : 0x3498db)
      .addFields(
        {
          name: "Fonte consultada",
          value: `${sourceIcon(consultedSource)} ${sourceLabel(consultedSource)}`,
          inline: true,
        },
        {
          name: "Tempo da consulta",
          value: `${(result.durationMs / 1000).toFixed(1)}s`,
          inline: true,
        },
      );

    if (consultedSource !== source) {
      embed.addFields({
        name: "Fonte original",
        value: `${sourceIcon(source)} ${sourceLabel(source)} não retornou capítulos; usei uma fonte equivalente.`,
        inline: false,
      });
    }

    if (result.currentChapters == null) {
      embed.setDescription(
        "⚠️ A fonte não retornou um número de capítulos agora. " +
          "A linha de base não foi alterada e nenhuma notificação foi enviada.",
      );
    } else if (result.isProxy) {
      embed
        .setDescription(
          "ℹ️ A fonte retornou apenas um indicador de atualização, não uma contagem real de capítulos. " +
            "Por isso, esta consulta não confirma lançamento nem envia notificação.",
        )
        .addFields({
          name: "Indicador retornado",
          value: String(result.currentChapters),
          inline: true,
        });
    } else if (result.lastChapters == null) {
      embed
        .setDescription(
          "ℹ️ A API respondeu, mas ainda não existe uma linha de base salva para comparar. " +
            "Nenhuma notificação foi enviada.",
        )
        .addFields({
          name: "Capítulo atual",
          value: String(result.currentChapters),
          inline: true,
        });
    } else {
      const difference = result.currentChapters - result.lastChapters;
      const status =
        result.hasNewChapters === true
          ? `🆕 Há ${difference} capítulo(s) além da última referência salva.`
          : result.hasNewChapters === false
            ? "✅ Nenhum capítulo novo em relação à última referência salva."
            : "⚠️ A API retornou um valor que precisa de revisão.";
      embed
        .setDescription(`${status}\n\nEsta foi uma consulta de diagnóstico; o estado automático não foi alterado.`)
        .addFields(
          { name: "Último salvo", value: String(result.lastChapters), inline: true },
          { name: "Atual na API", value: String(result.currentChapters), inline: true },
        );
    }

    embed.setFooter({ text: "Verificação manual • sem notificação e sem alteração de estado" });
    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply(
      "❌ Não foi possível consultar essa fonte agora. Nenhuma linha de base foi alterada.",
    );
  }
}