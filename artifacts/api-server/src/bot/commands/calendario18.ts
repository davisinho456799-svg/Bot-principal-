/**
 * Comando /calendario18 — calendário de conteúdo adulto (+18) em lançamento.
 * Fontes:
 *   • AniList   — animes adultos em lançamento (por próximo episódio)
 *   • VNDB      — visual novels adultas lançadas recentemente
 *   • Erogamescape — eroge japoneses recentes
 *
 * ⚠️  Exibe apenas títulos marcados como +18 pelas respectivas fontes.
 */

import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { fetchVNDBAdultCalendar, type VNDBResult } from "../vndb.js";
import { fetchErogamescapeCalendar, type ErogamescapeResult } from "../erogamescape.js";

const ANILIST_API = "https://graphql.anilist.co";

// ─── AniList ──────────────────────────────────────────────────────────────────

const ADULT_AIRING_QUERY = `
query AdultAiringAnime($page: Int) {
  Page(page: $page, perPage: 25) {
    pageInfo { hasNextPage }
    media(
      type: ANIME
      status: RELEASING
      isAdult: true
      sort: POPULARITY_DESC
    ) {
      id
      title { romaji english }
      genres
      averageScore
      siteUrl
      coverImage { color }
      nextAiringEpisode { episode airingAt }
      startDate { year }
      studios(isMain: true) { nodes { name } }
    }
  }
}
`;

interface AdultMedia {
  id: number;
  title: { romaji: string; english: string | null };
  genres: string[];
  averageScore: number | null;
  siteUrl: string;
  coverImage: { color: string | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  startDate: { year: number | null };
  studios: { nodes: { name: string }[] };
}

async function fetchAdultAiring(page = 1): Promise<{ list: AdultMedia[]; hasNext: boolean }> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: ADULT_AIRING_QUERY, variables: { page } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { media: AdultMedia[]; pageInfo: { hasNextPage: boolean } } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return {
    list: json.data.Page.media ?? [],
    hasNext: json.data.Page.pageInfo.hasNextPage,
  };
}

// ─── Filtros de data (anime) ──────────────────────────────────────────────────

function nowTs(): number { return Math.floor(Date.now() / 1000); }

function endOfDay(offsetDays = 0): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1000);
}

function endOfWeek(): number { return nowTs() + 7 * 86_400; }

function endOfMonth(): number {
  const d = new Date();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return Math.floor(end.getTime() / 1000);
}

function formatAiringDate(airingAt: number): string {
  return new Date(airingAt * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Builders de embed ────────────────────────────────────────────────────────

function buildAnimeEmbed(filtered: AdultMedia[], periodoLabel: string): EmbedBuilder {
  const color = filtered[0]?.coverImage.color
    ? parseInt(filtered[0].coverImage.color.replace("#", ""), 16)
    : 0xc0392b;

  const lines = filtered.slice(0, 15).map((m, i) => {
    const title = m.title.english ?? m.title.romaji;
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const genres = m.genres.slice(0, 2).join(", ") || "—";
    const studio = m.studios.nodes[0]?.name ?? "—";

    let airingLine: string;
    if (m.nextAiringEpisode) {
      const t = formatAiringDate(m.nextAiringEpisode.airingAt);
      airingLine = `📡 Ep ${m.nextAiringEpisode.episode} — ${t}`;
    } else {
      const yr = m.startDate.year ? `(${m.startDate.year})` : "";
      airingLine = `📡 Sem ep agendado ${yr}`;
    }

    return (
      `**${i + 1}.** [${title}](${m.siteUrl}) — ${score}\n` +
      `> ${airingLine}\n` +
      `> 🏢 ${studio} • 🏷️ ${genres}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`🔞 Calendário +18 — Anime (${periodoLabel})`)
    .setDescription(
      `⚠️ Títulos marcados como adultos pelo **AniList**.\n\n` +
      (lines.length ? lines.join("\n\n").slice(0, 3500) : "_Nenhum anime +18 encontrado para esse período._"),
    )
    .setColor(color)
    .setFooter({
      text: `${filtered.length} título(s) • Horários em horário de Brasília • Fonte: AniList`,
    });
}

function buildVNDBEmbed(vns: VNDBResult[]): EmbedBuilder {
  const lines = vns.slice(0, 10).map((vn, i) => {
    const score  = vn.score   ? `⭐ ${vn.score}/100` : "⭐ N/A";
    const length = vn.length  ? `⏱️ ${vn.length}` : "";
    const dev    = vn.developers[0] ?? "—";
    const rel    = vn.released ?? "Data desconhecida";
    const tags   = vn.tags.slice(0, 3).join(", ") || "—";
    const langs  = vn.languages.length ? `🌐 ${vn.languages.slice(0, 4).join(" ")}` : "";

    return (
      `**${i + 1}.** [${vn.mainTitle}](${vn.siteUrl}) — ${score}\n` +
      `> 📅 ${rel} • 🏢 ${dev}${length ? ` • ${length}` : ""}${langs ? `\n> ${langs}` : ""}\n` +
      `> 🏷️ ${tags}`
    );
  });

  return new EmbedBuilder()
    .setTitle("🔞 Calendário +18 — Visual Novels (VNDB)")
    .setDescription(
      `⚠️ VNs com conteúdo adulto lançadas nos últimos **~3 meses**.\n\n` +
      (lines.length ? lines.join("\n\n").slice(0, 3500) : "_Nenhuma VN adulta encontrada no período._"),
    )
    .setColor(0x337ab7)
    .setFooter({ text: `${vns.length} título(s) • Ordenado por avaliação • Fonte: VNDB` });
}

function buildErogeEmbed(games: ErogamescapeResult[]): EmbedBuilder {
  const lines = games.slice(0, 10).map((g, i) => {
    const score = g.score     ? `⭐ ${g.score}/100` : "⭐ N/A";
    const votes = g.votecount ? ` (${g.votecount} votos)` : "";
    const dev   = g.developer ?? "—";
    const date  = g.releaseDate ?? "—";
    const tags  = g.tags.slice(0, 3).join(", ") || "—";

    return (
      `**${i + 1}.** [${g.mainTitle}](${g.siteUrl}) — ${score}${votes}\n` +
      `> 📅 ${date} • 🏢 ${dev}\n` +
      `> 🏷️ ${tags}`
    );
  });

  return new EmbedBuilder()
    .setTitle("🔞 Calendário +18 — Eroge (Erogamescape)")
    .setDescription(
      `⚠️ Jogos eroge japoneses recentes.\n\n` +
      (lines.length ? lines.join("\n\n").slice(0, 3500) : "_Nenhum eroge encontrado no período._"),
    )
    .setColor(0x8e44ad)
    .setFooter({ text: `${games.length} título(s) • Fonte: Erogamescape` });
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("calendario18")
  .setDescription("⚠️ +18 — Calendário de animes, VNs e eroge adultos em lançamento")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Filtrar animes por período do próximo episódio")
      .setRequired(false)
      .addChoices(
        { name: "Todos em lançamento", value: "todos" },
        { name: "Hoje",               value: "hoje"   },
        { name: "Amanhã",             value: "amanha" },
        { name: "Esta semana",        value: "semana" },
        { name: "Este mês",           value: "mes"    },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName("fonte")
      .setDescription("Mostrar apenas uma fonte específica (padrão: todas)")
      .setRequired(false)
      .addChoices(
        { name: "Todas",          value: "todas"         },
        { name: "🎬 Anime",      value: "anime"         },
        { name: "📖 Visual Novel", value: "vn"          },
        { name: "🎮 Eroge",      value: "eroge"         },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "todos";
  const fonte   = interaction.options.getString("fonte")   ?? "todas";

  await interaction.deferReply();

  const showAnime = fonte === "todas" || fonte === "anime";
  const showVN    = fonte === "todas" || fonte === "vn";
  const showEroge = fonte === "todas" || fonte === "eroge";

  // ── Busca em paralelo ────────────────────────────────────────────────────────
  const [animeResult, vnResult, erogeResult] = await Promise.allSettled([
    showAnime ? Promise.all([fetchAdultAiring(1), fetchAdultAiring(2)]) : Promise.resolve(null),
    showVN    ? fetchVNDBAdultCalendar(2, 1)   : Promise.resolve([]),
    showEroge ? fetchErogamescapeCalendar()    : Promise.resolve([]),
  ]);

  const embeds: EmbedBuilder[] = [];

  // ── Seção: Anime ─────────────────────────────────────────────────────────────
  if (showAnime) {
    let animeList: AdultMedia[] = [];

    if (animeResult.status === "fulfilled" && animeResult.value) {
      const [p1, p2] = animeResult.value as [
        { list: AdultMedia[]; hasNext: boolean },
        { list: AdultMedia[]; hasNext: boolean },
      ];
      animeList = [...p1.list, ...p2.list];
    }

    const now      = nowTs();
    let deadline: number | null = null;
    let periodoLabel = "Em Lançamento";

    switch (periodo) {
      case "hoje":   deadline = endOfDay(0);  periodoLabel = "Hoje";        break;
      case "amanha": deadline = endOfDay(1);  periodoLabel = "Amanhã";      break;
      case "semana": deadline = endOfWeek();  periodoLabel = "Esta Semana"; break;
      case "mes":    deadline = endOfMonth(); periodoLabel = "Este Mês";    break;
    }

    let filtered = animeList;
    if (deadline !== null) {
      filtered = animeList.filter(
        (m) =>
          m.nextAiringEpisode &&
          m.nextAiringEpisode.airingAt >= now &&
          m.nextAiringEpisode.airingAt <= deadline!,
      );
    }

    filtered.sort((a, b) => {
      const aAt = a.nextAiringEpisode?.airingAt ?? Infinity;
      const bAt = b.nextAiringEpisode?.airingAt ?? Infinity;
      return aAt - bAt;
    });

    embeds.push(buildAnimeEmbed(filtered, periodoLabel));
  }

  // ── Seção: VNDB ───────────────────────────────────────────────────────────────
  if (showVN) {
    const vns = vnResult.status === "fulfilled" ? (vnResult.value as VNDBResult[]) : [];
    embeds.push(buildVNDBEmbed(vns));
  }

  // ── Seção: Erogamescape ───────────────────────────────────────────────────────
  if (showEroge) {
    const games = erogeResult.status === "fulfilled" ? (erogeResult.value as ErogamescapeResult[]) : [];
    embeds.push(buildErogeEmbed(games));
  }

  if (!embeds.length) {
    await interaction.editReply("❌ Selecione ao menos uma fonte válida.");
    return;
  }

  await interaction.editReply({ embeds });
}
