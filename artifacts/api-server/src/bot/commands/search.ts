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
  searchAllSources,
  searchByDescriptionSemantic,
  getUnifiedById,
  type UnifiedResult,
  type DescriptionSearchResult,
} from "../unified.js";
import { cleanDescription, translateToPtBr, statusLabel } from "../anilist.js";
import { findDirectLinks } from "../exa.js";
import { respondAutocomplete } from "../autocomplete.js";

export const data = new SlashCommandBuilder()
  .setName("manhwa")
  .setDescription("Pesquisa um manhwa no AniList e MangaDex com sinopse traduzida")
  .addStringOption((opt) =>
    opt.setName("titulo").setDescription("Nome do manhwa para pesquisar").setRequired(false).setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("descricao")
      .setDescription('Descreva o manhwa que você quer achar (ex: "herói que morre e fica mais forte")')
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  await respondAutocomplete(interaction, focused);
}

const SOURCE_LABELS: Record<string, string> = {
  anilist: "AniList",
  mangadex: "MangaDex",
  comick: "Comick.io",
  mangaupdates: "MangaUpdates",
  jikan: "MyAnimeList",
};

const SOURCE_ICONS: Record<string, string> = {
  anilist: "🟣",
  mangadex: "🟠",
  comick: "🟢",
  mangaupdates: "🔵",
  jikan: "🔴",
};

function buildAltTitles(r: UnifiedResult): string | null {
  const seen = new Set<string>([r.mainTitle.toLowerCase()]);
  const titles: string[] = [];

  for (const t of [r.nativeTitle, r.romajiTitle, ...r.synonyms]) {
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      titles.push(t);
    }
  }

  return titles.length ? titles.slice(0, 6).join("\n") : null;
}

const FALLBACK_SITES = [
  { name: "NexusToons", url: "https://nexustoons.com", search: "/?s=" },
  { name: "InkApk", url: "https://inkapk.net", search: "/?s=" },
  { name: "ReMangas", url: "https://remangas.net", search: "/?s=" },
  { name: "MangaHost", url: "https://mangahost4.com", search: "/find/" },
  { name: "UnionMangas", url: "https://unionleitor.top", search: "/lista-mangas/0/0/0/0/1/0/0?busca=" },
  { name: "MangaLivre", url: "https://mangalivre.net", search: "/series/index/busca=" },
  { name: "TsukiMangás", url: "https://tsukimangas.com", search: "/?busca=" },
  { name: "SeitaManga", url: "https://seitamanga.com", search: "/?s=" },
  { name: "SlimeRead", url: "https://slimeread.com.br", search: "/?s=" },
];

function buildFallbackLinks(title: string): string {
  const encoded = encodeURIComponent(title);
  return FALLBACK_SITES.map(
    (site) => `[${site.name}](${site.url}${site.search}${encoded})`
  ).join(" • ");
}

export function buildScanLinksExternal(title: string): string {
  return buildFallbackLinks(title);
}

async function buildEmbed(r: UnifiedResult, compatibilityScore?: number): Promise<EmbedBuilder> {
  const score = r.score ? `⭐ ${(r.score / 10).toFixed(1)}/10` : "⭐ N/A";
  const chapters = r.chapters ? `📖 ${r.chapters} capítulos` : "📖 Desconhecido";
  const status = `📌 ${statusLabel(r.status)}`;
  const genres = r.genres.length ? r.genres.slice(0, 6).join(" • ") : "Sem gêneros";
  const altTitles = buildAltTitles(r);
  const sourceLabel = SOURCE_LABELS[r.source] ?? r.source;
  const sourceIcon = SOURCE_ICONS[r.source] ?? "🔵";

  const rawDesc = cleanDescription(r.description);
  const [synopsis, directLinks] = await Promise.all([
    translateToPtBr(rawDesc),
    findDirectLinks(r.mainTitle),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(r.mainTitle)
    .setURL(r.siteUrl)
    .setDescription(synopsis || "Sem sinopse disponível.")
    .setColor(r.accentColor)
    .addFields(
      { name: "Avaliação", value: score, inline: true },
      { name: "Capítulos", value: chapters, inline: true },
      { name: "Status", value: status, inline: true },
    );

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
  if (r.year) embed.addFields({ name: "Ano de início", value: String(r.year), inline: true });

  if (r.ptBrUrl) {
    embed.addFields({
      name: "🇧🇷 MangaDex PT-BR",
      value: `[Ler no MangaDex](${r.ptBrUrl})`,
      inline: false,
    });
  }

  // Links diretos (Exa) para os 3 sites principais
  const directLinksText = directLinks
    .map((l) => {
      if (l.direct) return `🟢 [${l.name}](${l.url})`;
      if (l.fallbackLabel) return `📂 [${l.name} — ${l.fallbackLabel}](${l.url})`;
      return `🔍 [${l.name}](${l.url})`;
    })
    .join("\n");

  embed.addFields({
    name: "📖 Ler nos sites BR",
    value: directLinksText,
    inline: false,
  });

  // Outros sites (busca genérica)
  embed.addFields({
    name: "🔎 Outros sites",
    value: buildFallbackLinks(r.mainTitle),
    inline: false,
  });

  embed.setFooter({
    text: `${sourceIcon} Fonte: ${sourceLabel} • Sinopse traduzida automaticamente`,
  });

  return embed;
}

export async function execute(interaction: ChatInputCommandInteraction) {
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

  if (descricao && !titulo) {
    isDescSearch = true;
    await interaction.editReply({
      content: `🔍 Analisando descrição e buscando em múltiplas fontes: *"${descricao}"*...\n⏳ Isso pode levar alguns segundos.`,
    });
    try {
      results = await searchByDescriptionSemantic(descricao);
    } catch {
      await interaction.editReply("❌ Erro ao buscar por descrição. Tente novamente.");
      return;
    }

    if (!results.length) {
      await interaction.editReply(
        `❌ Não encontrei nenhum manhwa com essa descrição. Tente ser mais específico ou use o título.`
      );
      return;
    }
  } else {
    const query = titulo!;

    // ✅ Se o valor vier do autocomplete no formato "source:id", vai direto ao resultado
    if (/^(anilist|comick|mangadex|mangaupdates|jikan):[^\s|]+$/.test(query)) {
      try {
        const [source, ...idParts] = query.split(":");
        const id = idParts.join(":");
        const direct = await getUnifiedById(
          source as "anilist" | "mangadex" | "comick" | "mangaupdates" | "jikan",
          id
        );
        if (direct) {
          const embed = await buildEmbed(direct);
          await interaction.editReply({ content: null, embeds: [embed] });
          return;
        }
      } catch {
        // falhou — cai no searchAllSources abaixo
      }
    }

    try {
      results = await searchAllSources(query);
    } catch {
      await interaction.editReply("❌ Erro ao consultar as fontes. Tente novamente.");
      return;
    }

    if (!results.length) {
      await interaction.editReply(
        `❌ Nenhum manhwa encontrado para **${query}**.\nDica: tente usar o campo \`descricao\` para descrever o manhwa com suas palavras!`
      );
      return;
    }
  }

  // Para busca por descrição, extrair compatibilityScore se presente
  function getScore(r: UnifiedResult): number | undefined {
    return isDescSearch ? (r as DescriptionSearchResult).compatibilityScore : undefined;
  }

  if (results.length === 1) {
    const embed = await buildEmbed(results[0], getScore(results[0]));
    await interaction.editReply({ content: null, embeds: [embed] });
    return;
  }

  // Codifica score no value usando | como separador (IDs não usam |)
  const options = results.slice(0, 8).map((r) => {
    const icon = SOURCE_ICONS[r.source] ?? "🔵";
    const score = getScore(r);
    const scoreText = score != null ? `${score}% • ` : "";
    return {
      label: `${r.mainTitle}`.slice(0, 100),
      description: `${icon} ${SOURCE_LABELS[r.source] ?? r.source} • ${scoreText}${r.genres.slice(0, 2).join(", ") || "Sem gêneros"}`.slice(0, 100),
      value: score != null ? `${r.source}:${r.id}|${score}` : `${r.source}:${r.id}`,
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("manhwa_select")
      .setPlaceholder("Selecione o manhwa correto")
      .addOptions(options)
  );

  const sourceSet = new Set(results.map((r) => r.source));
  const sourcesSummary = [
    sourceSet.has("anilist") ? "🟣 AniList" : null,
    sourceSet.has("mangadex") ? "🟠 MangaDex" : null,
    sourceSet.has("comick") ? "🟢 Comick" : null,
    sourceSet.has("mangaupdates") ? "🔵 MangaUpdates" : null,
    sourceSet.has("jikan") ? "🔴 MAL" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const headerText = isDescSearch
    ? `🎯 Encontrei **${results.length}** manhwas compatíveis com sua descrição (${sourcesSummary}). Selecione abaixo:`
    : `🔍 Encontrei **${results.length}** resultados em ${sourcesSummary}. Selecione abaixo:`;

  await interaction.editReply({
    content: headerText,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "manhwa_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (selectInteraction: StringSelectMenuInteraction) => {
    await selectInteraction.deferUpdate();
    try {
      // Decodifica score do value (formato: "source:id|score" ou "source:id")
      const rawValue = selectInteraction.values[0];
      const [sourceId, scoreStr] = rawValue.split("|");
      const [source, ...idParts] = sourceId.split(":");
      const id = idParts.join(":");
      const decodedScore = scoreStr ? parseInt(scoreStr, 10) : undefined;

      const manhwa = await getUnifiedById(
        source as "anilist" | "mangadex" | "comick" | "mangaupdates" | "jikan",
        id
      );
      if (!manhwa) {
        await interaction.editReply({
          content: "❌ Não foi possível carregar os detalhes desse título. Tente outro resultado.",
          components: [],
        });
        return;
      }
      const embed = await buildEmbed(manhwa, decodedScore);
      await interaction.editReply({ content: null, embeds: [embed], components: [] });
    } catch {
      await interaction.editReply({ content: "❌ Erro inesperado ao buscar os detalhes. Tente novamente.", components: [] });
    }
  });

  collector?.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await interaction.editReply({
        content: "⏱️ Tempo esgotado. Use `/manhwa` novamente.",
        components: [],
      });
    }
  });
}
