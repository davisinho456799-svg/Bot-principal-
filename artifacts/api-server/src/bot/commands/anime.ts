/**
 * Comando /anime — busca animes por título ou descrição.
 * Fontes: AniList, Jikan/MAL, Kitsu.io
 * Mostra: episódios, tipo, temporada, estúdios, links de streaming, sites PT-BR.
 */

import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import {
  searchAllAnimeSources,
  searchAnimeByDescriptionEnhanced,
  getUnifiedAnimeById,
  type UnifiedResult,
  type DescriptionSearchResult,
} from "../unified.js";
import { cleanDescription, translateToPtBr, statusLabel, searchAnime } from "../anilist.js";
import { searchKitsu } from "../kitsu.js";
import { searchVNDB, getVNDBById } from "../vndb.js";
import { searchErogamescape, getErogamescapeDetail } from "../erogamescape.js";

export const data = new SlashCommandBuilder()
  .setName("anime")
  .setDescription("Pesquisa um anime com sinopse traduzida, episódios, estúdios e onde assistir")
  .addStringOption((opt) =>
    opt
      .setName("titulo")
      .setDescription("Nome do anime para pesquisar")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("descricao")
      .setDescription('Descreva o anime que você quer achar (ex: "dois irmãos alquimistas procuram pedra filosofal")')
      .setRequired(false)
  );

// ─── Autocomplete ─────────────────────────────────────────────────────────────

interface AutocompleteOption { name: string; value: string }
const autocompleteCache = new Map<string, { results: AutocompleteOption[]; ts: number }>();
const CACHE_TTL = 30_000;

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  if (!focused || focused.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cached = autocompleteCache.get(focused);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    await interaction.respond(cached.results);
    return;
  }

  try {
    const [anilistResults, kitsuResults, vndbResults, erogeResults] = await Promise.allSettled([
      searchAnime(focused),
      searchKitsu(focused),
      searchVNDB(focused),
      searchErogamescape(focused),
    ]);

    const seen = new Set<string>();
    const options: AutocompleteOption[] = [];

    // AniList: value = "anilist-anime:<id>"
    if (anilistResults.status === "fulfilled") {
      for (const r of anilistResults.value) {
        const t = r.title.english ?? r.title.romaji;
        if (t && !seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          options.push({ name: t.slice(0, 100), value: `anilist-anime:${r.id}` });
        }
      }
    }
    // Kitsu: value = "kitsu:<kitsuId>"
    if (kitsuResults.status === "fulfilled") {
      for (const r of kitsuResults.value) {
        if (!seen.has(r.mainTitle.toLowerCase())) {
          seen.add(r.mainTitle.toLowerCase());
          options.push({ name: r.mainTitle.slice(0, 100), value: `kitsu:${r.kitsuId}` });
        }
      }
    }
    // VNDB: value = "vndb:<vnId>"
    if (vndbResults.status === "fulfilled") {
      for (const r of vndbResults.value) {
        if (!seen.has(r.mainTitle.toLowerCase())) {
          seen.add(r.mainTitle.toLowerCase());
          options.push({ name: `[VN] ${r.mainTitle}`.slice(0, 100), value: `vndb:${r.vnId}` });
        }
      }
    }
    // Erogamescape: value = "erogamescape:<gameId>"
    if (erogeResults.status === "fulfilled") {
      for (const r of erogeResults.value) {
        if (!seen.has(r.mainTitle.toLowerCase())) {
          seen.add(r.mainTitle.toLowerCase());
          options.push({ name: `[Eroge] ${r.mainTitle}`.slice(0, 100), value: `erogamescape:${r.gameId}` });
        }
      }
    }

    const top = options.slice(0, 25);
    autocompleteCache.set(focused, { results: top, ts: Date.now() });
    await interaction.respond(top);
  } catch {
    await interaction.respond([]);
  }
}

// ─── Labels e ícones ──────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  "anilist-anime": "AniList",
  jikan: "MyAnimeList",
  kitsu: "Kitsu",
  anidb: "AniDB",
  vndb: "VNDB",
  erogamescape: "Erogamescape",
};

const SOURCE_ICONS: Record<string, string> = {
  "anilist-anime": "🟣",
  jikan: "🔴",
  kitsu: "🔵",
  anidb: "🟤",
  vndb: "🔵",
  erogamescape: "🔴",
};

// ─── Links de streaming PT-BR (fallback) ─────────────────────────────────────

const PTBR_STREAMING_SITES = [
  { name: "AnimeFire", url: "https://animefire.plus/pesquisar/" },
  { name: "GoAnimes", url: "https://goanimes.net/?s=" },
  { name: "Goyabu", url: "https://goyabu.com/search?q=" },
  { name: "AnimeUnited", url: "https://www.animeunited.com.br/?s=" },
  { name: "AnimesOnline", url: "https://animesonline.cx/animes/?busca=" },
  { name: "BetterAnime", url: "https://www.betteranime.net/search?q=" },
  { name: "AnimesHouse", url: "https://animeshouse.net/?s=" },
];

function buildPtBrStreamingLinks(title: string): string {
  const encoded = encodeURIComponent(title);
  return PTBR_STREAMING_SITES.map((s) => `[${s.name}](${s.url}${encoded})`).join(" • ");
}

function buildAltTitles(r: UnifiedResult): string | null {
  const seen = new Set<string>([r.mainTitle.toLowerCase()]);
  const titles: string[] = [];
  for (const t of [r.nativeTitle, r.romajiTitle, ...r.synonyms]) {
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); titles.push(t); }
  }
  return titles.length ? titles.slice(0, 5).join("\n") : null;
}

// ─── Embed ────────────────────────────────────────────────────────────────────

async function buildAnimeEmbed(r: UnifiedResult, compatibilityScore?: number): Promise<EmbedBuilder> {
  const scoreField = r.score ? `⭐ ${(r.score / 10).toFixed(1)}/10` : "⭐ N/A";
  const episodesField = r.episodes ? `📺 ${r.episodes} eps` : "📺 Desconhecido";
  const statusField = `📌 ${statusLabel(r.status)}`;
  const genres = r.genres.length ? r.genres.slice(0, 6).join(" • ") : "Sem gêneros";
  const altTitles = buildAltTitles(r);
  const sourceLabel = SOURCE_LABELS[r.source] ?? r.source;
  const sourceIcon = SOURCE_ICONS[r.source] ?? "🔵";

  const rawDesc = cleanDescription(r.description);
  const synopsis = await translateToPtBr(rawDesc);

  const embed = new EmbedBuilder()
    .setTitle(r.mainTitle)
    .setURL(r.siteUrl)
    .setDescription(synopsis || "Sem sinopse disponível.")
    .setColor(r.accentColor)
    .addFields(
      { name: "Avaliação", value: scoreField, inline: true },
      { name: "Episódios", value: episodesField, inline: true },
      { name: "Status", value: statusField, inline: true },
    );

  // Tipo + Temporada + Estúdio(s)
  const typeField = r.animeType ?? "—";
  const seasonField = r.season && r.seasonYear
    ? `${r.season} ${r.seasonYear}`
    : r.season ?? (r.year ? String(r.year) : "—");

  embed.addFields(
    { name: "Tipo", value: typeField, inline: true },
    { name: "Temporada", value: seasonField, inline: true },
  );

  if (r.studios && r.studios.length > 0) {
    embed.addFields({ name: "Estúdio(s)", value: r.studios.slice(0, 3).join(", "), inline: true });
  }

  if (compatibilityScore != null) {
    const bar = compatibilityScore >= 70 ? "🟢" : compatibilityScore >= 40 ? "🟡" : "🟠";
    embed.addFields({
      name: "🎯 Compatibilidade",
      value: `${bar} **${compatibilityScore}%** com sua descrição`,
      inline: true,
    });
  }

  embed.addFields({ name: "Gêneros", value: genres, inline: false });

  if (r.coverUrl) embed.setThumbnail(r.coverUrl);
  if (altTitles) embed.addFields({ name: "Títulos alternativos", value: altTitles, inline: false });

  // Links de streaming (AniList externalLinks)
  if (r.streamingLinks && r.streamingLinks.length > 0) {
    const streamText = r.streamingLinks
      .map((l) => `[${l.site}](${l.url})`)
      .join(" • ");
    embed.addFields({ name: "▶️ Streaming (global)", value: streamText, inline: false });
  }

  // Trailer
  if (r.trailerUrl) {
    embed.addFields({ name: "🎬 Trailer", value: `[Assistir no YouTube](${r.trailerUrl})`, inline: false });
  }

  // Sites PT-BR
  embed.addFields({
    name: "🇧🇷 Assistir em PT-BR",
    value: buildPtBrStreamingLinks(r.mainTitle),
    inline: false,
  });

  embed.setFooter({
    text: `${sourceIcon} Fonte: ${sourceLabel} • Sinopse traduzida automaticamente`,
  });

  return embed;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const titulo = interaction.options.getString("titulo");
  const descricao = interaction.options.getString("descricao");

  if (!titulo && !descricao) {
    await interaction.reply({
      content: "❌ Informe pelo menos um **título** ou uma **descrição** para buscar.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  let results: UnifiedResult[];
  let isDescSearch = false;

  // Detecta se o título veio do autocomplete (formato "source:id")
  const AUTOCOMPLETE_RE = /^(anilist-anime|jikan|kitsu|anidb|vndb|erogamescape):(.+)$/;
  const autocompleteMatch = titulo ? AUTOCOMPLETE_RE.exec(titulo) : null;

  if (autocompleteMatch) {
    // Seleção direta do autocomplete → busca por ID, sem pesquisa textual
    const source = autocompleteMatch[1] as "anilist-anime" | "jikan" | "kitsu" | "anidb" | "vndb" | "erogamescape";
    const id = autocompleteMatch[2]!;
    try {
      const anime = await getUnifiedAnimeById(source, id);
      if (!anime) {
        await interaction.editReply("❌ Não foi possível carregar os detalhes. Tente digitar o título manualmente.");
        return;
      }
      const embed = await buildAnimeEmbed(anime);
      await interaction.editReply({ content: null, embeds: [embed] });
    } catch {
      await interaction.editReply("❌ Erro ao buscar detalhes. Tente novamente.");
    }
    return;
  }

  if (descricao && !titulo) {
    isDescSearch = true;
    await interaction.editReply({
      content: `🔍 Analisando descrição e buscando animes: *"${descricao}"*...\n⏳ Isso pode levar alguns segundos.`,
    });
    try {
      results = await searchAnimeByDescriptionEnhanced(descricao);
    } catch {
      await interaction.editReply("❌ Erro ao buscar por descrição. Tente novamente.");
      return;
    }
    if (!results.length) {
      await interaction.editReply(
        "❌ Não encontrei nenhum anime com essa descrição. Tente ser mais específico ou use o título."
      );
      return;
    }
  } else {
    try {
      results = await searchAllAnimeSources(titulo!);
    } catch {
      await interaction.editReply("❌ Erro ao consultar as fontes. Tente novamente.");
      return;
    }
    if (!results.length) {
      await interaction.editReply(
        `❌ Nenhum anime encontrado para **${titulo}**.\nDica: tente usar o campo \`descricao\` para descrever o anime!`
      );
      return;
    }
  }

  function getScore(r: UnifiedResult): number | undefined {
    return isDescSearch ? (r as DescriptionSearchResult).compatibilityScore : undefined;
  }

  if (results.length === 1) {
    const embed = await buildAnimeEmbed(results[0], getScore(results[0]));
    await interaction.editReply({ content: null, embeds: [embed] });
    return;
  }

  const options = results.slice(0, 8).map((r) => {
    const icon = SOURCE_ICONS[r.source] ?? "🔵";
    const score = getScore(r);
    const scoreText = score != null ? `${score}% • ` : "";
    const typeText = r.animeType ? `${r.animeType} • ` : "";
    return {
      label: r.mainTitle.slice(0, 100),
      description: `${icon} ${SOURCE_LABELS[r.source] ?? r.source} • ${scoreText}${typeText}${r.genres.slice(0, 2).join(", ") || "Sem gêneros"}`.slice(0, 100),
      value: score != null ? `${r.source}:${r.id}|${score}` : `${r.source}:${r.id}`,
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("anime_select")
      .setPlaceholder("Selecione o anime correto")
      .addOptions(options)
  );

  const sourceSet = new Set(results.map((r) => r.source));
  const sourcesSummary = [
    sourceSet.has("anilist-anime") ? "🟣 AniList" : null,
    sourceSet.has("jikan") ? "🔴 MAL" : null,
    sourceSet.has("kitsu") ? "🔵 Kitsu" : null,
    sourceSet.has("vndb") ? "🔵 VNDB" : null,
    sourceSet.has("erogamescape") ? "🔴 Erogamescape" : null,
  ].filter(Boolean).join(" + ");

  const headerText = isDescSearch
    ? `🎯 Encontrei **${results.length}** animes compatíveis (${sourcesSummary}). Selecione:`
    : `🔍 Encontrei **${results.length}** resultados em ${sourcesSummary}. Selecione:`;

  await interaction.editReply({ content: headerText, components: [row] });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "anime_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (selectInteraction: StringSelectMenuInteraction) => {
    await selectInteraction.deferUpdate();
    try {
      const rawValue = selectInteraction.values[0];
      const [sourceId, scoreStr] = rawValue.split("|");
      const [source, ...idParts] = sourceId.split(":");
      const id = idParts.join(":");
      const decodedScore = scoreStr ? parseInt(scoreStr, 10) : undefined;

      const anime = await getUnifiedAnimeById(
        source as "anilist-anime" | "jikan" | "kitsu" | "anidb" | "vndb" | "erogamescape",
        id
      );
      if (!anime) {
        await interaction.editReply({ content: "❌ Não foi possível carregar os detalhes. Tente outro resultado.", components: [] });
        return;
      }
      const embed = await buildAnimeEmbed(anime, decodedScore);
      await interaction.editReply({ content: null, embeds: [embed], components: [] });
    } catch {
      await interaction.editReply({ content: "❌ Erro inesperado. Tente novamente.", components: [] });
    }
  });

  collector?.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await interaction.editReply({ content: "⏱️ Tempo esgotado. Use `/anime` novamente.", components: [] });
    }
  });
}
