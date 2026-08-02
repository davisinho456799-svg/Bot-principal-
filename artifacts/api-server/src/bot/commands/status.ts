/**
 * Comando /status — verifica o status de publicação de um anime ou manhwa/manga.
 * Fontes: AniList (primária), Jikan/MAL (fallback para anime).
 */

import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { searchAnime, searchManhwa } from "../anilist.js";
import { searchAllAnimeSources, getUnifiedAnimeById } from "../unified.js";
import { respondAutocomplete } from "../autocomplete.js";

// ─── Labels ───────────────────────────────────────────────────────────────────

const STATUS_INFO: Record<string, { label: string; emoji: string; color: number; desc: string }> = {
  RELEASING: {
    label: "Em lançamento",
    emoji: "🟢",
    color: 0x2ecc71,
    desc: "Está sendo publicado atualmente.",
  },
  FINISHED: {
    label: "Finalizado",
    emoji: "✅",
    color: 0x3498db,
    desc: "A publicação foi concluída.",
  },
  CANCELLED: {
    label: "Cancelado",
    emoji: "❌",
    color: 0xe74c3c,
    desc: "Foi cancelado e não terá novos capítulos/episódios.",
  },
  HIATUS: {
    label: "Em hiato",
    emoji: "⏸️",
    color: 0xf39c12,
    desc: "Está pausado temporariamente.",
  },
  NOT_YET_RELEASED: {
    label: "Não lançado",
    emoji: "🔜",
    color: 0x9b59b6,
    desc: "Ainda não foi lançado.",
  },
};

const ANILIST_API = "https://graphql.anilist.co";

// ─── Busca direta AniList ─────────────────────────────────────────────────────

const DETAIL_QUERY = `
query StatusCheck($search: String!, $type: MediaType) {
  Page(page: 1, perPage: 3) {
    media(search: $search, type: $type, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      type
      status
      averageScore
      chapters
      episodes
      startDate { year month day }
      endDate { year month day }
      genres
      siteUrl
      coverImage { large color }
      nextAiringEpisode { episode airingAt }
    }
  }
}
`;

interface ALMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  type: string;
  status: string;
  averageScore: number | null;
  chapters: number | null;
  episodes: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  endDate: { year: number | null; month: number | null; day: number | null };
  genres: string[];
  siteUrl: string;
  coverImage: { large: string; color: string | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
}

async function searchAniListStatus(query: string, type?: "ANIME" | "MANGA"): Promise<ALMedia[]> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: DETAIL_QUERY, variables: { search: query, type: type ?? null } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data: { Page: { media: ALMedia[] } };
    errors?: unknown[];
  };
  if (json.errors?.length) return [];
  return json.data.Page.media ?? [];
}

function formatDate(d: { year: number | null; month: number | null; day: number | null }): string {
  if (!d.year) return "—";
  if (!d.month) return String(d.year);
  if (!d.day) return `${d.month.toString().padStart(2, "0")}/${d.year}`;
  return `${d.day.toString().padStart(2, "0")}/${d.month.toString().padStart(2, "0")}/${d.year}`;
}

function buildStatusEmbed(m: ALMedia): EmbedBuilder {
  const info = STATUS_INFO[m.status] ?? { label: m.status, emoji: "❓", color: 0x95a5a6, desc: "" };
  const title = m.title.english ?? m.title.romaji;
  const isAnime = m.type === "ANIME";

  const color = m.coverImage.color
    ? parseInt(m.coverImage.color.replace("#", ""), 16)
    : info.color;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(m.siteUrl)
    .setColor(color)
    .setThumbnail(m.coverImage.large)
    .addFields({
      name: "📌 Status",
      value: `${info.emoji} **${info.label}**\n${info.desc}`,
      inline: false,
    });

  if (m.title.native) {
    embed.addFields({ name: "🈳 Título original", value: m.title.native, inline: true });
  }

  const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}/10` : "⭐ N/A";
  embed.addFields({ name: "Avaliação", value: score, inline: true });

  if (isAnime) {
    const eps = m.episodes ? `📺 ${m.episodes} episódios` : "📺 Desconhecido";
    embed.addFields({ name: "Episódios", value: eps, inline: true });
    if (m.nextAiringEpisode) {
      const nextDate = new Date(m.nextAiringEpisode.airingAt * 1000).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      embed.addFields({
        name: "📡 Próximo episódio",
        value: `Ep ${m.nextAiringEpisode.episode} — ${nextDate}`,
        inline: false,
      });
    }
  } else {
    const caps = m.chapters ? `📖 ${m.chapters} capítulos` : "📖 Em andamento";
    embed.addFields({ name: "Capítulos", value: caps, inline: true });
  }

  embed.addFields(
    { name: "📅 Início", value: formatDate(m.startDate), inline: true },
    { name: "🏁 Fim", value: formatDate(m.endDate), inline: true },
  );

  if (m.genres.length) {
    embed.addFields({ name: "🏷️ Gêneros", value: m.genres.slice(0, 6).join(" • "), inline: false });
  }

  const typeLabel = isAnime ? "Anime" : "Manga/Manhwa/Manhua";
  embed.setFooter({ text: `📋 Tipo: ${typeLabel} • Fonte: AniList` });

  return embed;
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

const autocompleteCache = new Map<string, { results: { name: string; value: string }[]; ts: number }>();
const CACHE_TTL = 30_000;

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  if (!focused || focused.length < 2) { await interaction.respond([]); return; }

  const tipo = interaction.options.getString("tipo") ?? "ambos";
  const cacheKey = `${tipo}:${focused}`;

  const cached = autocompleteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    await interaction.respond(cached.results);
    return;
  }

  try {
    const type = tipo === "anime" ? "ANIME" : tipo === "manga" ? "MANGA" : undefined;
    const results = await searchAniListStatus(focused, type);
    const options = results.slice(0, 10).map((m) => ({
      name: (m.title.english ?? m.title.romaji).slice(0, 100),
      value: `al:${m.id}:${m.type}`,
    }));
    autocompleteCache.set(cacheKey, { results: options, ts: Date.now() });
    await interaction.respond(options);
  } catch {
    await interaction.respond([]);
  }
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Mostra o status de publicação de um anime ou manga/manhwa (lançando, finalizado, hiato…)")
  .addStringOption((opt) =>
    opt
      .setName("titulo")
      .setDescription("Nome do anime, manga ou manhwa")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("tipo")
      .setDescription("Filtrar por tipo de mídia")
      .setRequired(false)
      .addChoices(
        { name: "Ambos", value: "ambos" },
        { name: "Anime", value: "anime" },
        { name: "Manga / Manhwa", value: "manga" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const titulo = interaction.options.getString("titulo", true);
  const tipo = interaction.options.getString("tipo") ?? "ambos";
  await interaction.deferReply();

  // Seleção do autocomplete (formato "al:ID:TYPE")
  const acMatch = /^al:(\d+):(ANIME|MANGA)$/.exec(titulo);

  try {
    let media: ALMedia | null = null;

    if (acMatch) {
      const id = parseInt(acMatch[1]!, 10);
      const type = acMatch[2] as "ANIME" | "MANGA";
      // Busca por ID diretamente
      const byId = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query($id:Int!,$type:MediaType){Media(id:$id,type:$type){id title{romaji english native}type status averageScore chapters episodes startDate{year month day}endDate{year month day}genres siteUrl coverImage{large color}nextAiringEpisode{episode airingAt}}}`,
          variables: { id, type },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (byId.ok) {
        const bjson = (await byId.json()) as { data: { Media: ALMedia } };
        media = bjson.data.Media ?? null;
      }
    } else {
      const type = tipo === "anime" ? "ANIME" : tipo === "manga" ? "MANGA" : undefined;
      const results = await searchAniListStatus(titulo, type);
      media = results[0] ?? null;
    }

    if (!media) {
      await interaction.editReply(
        `❌ Nenhum resultado encontrado para **${titulo}**. Tente um título diferente.`
      );
      return;
    }

    const embed = buildStatusEmbed(media);
    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar o status. Tente novamente em instantes.");
  }
}
