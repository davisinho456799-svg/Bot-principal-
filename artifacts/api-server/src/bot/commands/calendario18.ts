/**
 * Comando /calendario18 — calendário de animes +18 em lançamento.
 * Fonte: AniList (isAdult: true, status: RELEASING).
 * ⚠️  Exibe apenas títulos marcados como adultos pelo AniList.
 */

import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

// Busca animes adultos em lançamento com próximo episódio
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Busca ────────────────────────────────────────────────────────────────────

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

// ─── Filtros de data ──────────────────────────────────────────────────────────

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function endOfDay(offsetDays = 0): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1000);
}

function endOfWeek(): number {
  return nowTs() + 7 * 86_400;
}

function endOfMonth(): number {
  const d = new Date();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return Math.floor(end.getTime() / 1000);
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("calendario18")
  .setDescription("⚠️ +18 — Calendário de animes adultos em lançamento (próximos episódios)")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Filtrar por período de estreia do próximo ep")
      .setRequired(false)
      .addChoices(
        { name: "Todos em lançamento", value: "todos" },
        { name: "Hoje", value: "hoje" },
        { name: "Amanhã", value: "amanha" },
        { name: "Esta semana", value: "semana" },
        { name: "Este mês", value: "mes" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "todos";
  await interaction.deferReply();

  try {
    // Busca até 2 páginas para ter resultados suficientes
    const [p1, p2] = await Promise.allSettled([
      fetchAdultAiring(1),
      fetchAdultAiring(2),
    ]);

    let all: AdultMedia[] = [];
    if (p1.status === "fulfilled") all.push(...p1.value.list);
    if (p2.status === "fulfilled") all.push(...p2.value.list);

    if (!all.length) {
      await interaction.editReply("❌ Nenhum anime +18 em lançamento encontrado no AniList.");
      return;
    }

    // Filtro de período no nextAiringEpisode
    const now = nowTs();
    let deadline: number | null = null;
    let periodoLabel = "Em Lançamento";

    switch (periodo) {
      case "hoje":
        deadline = endOfDay(0);
        periodoLabel = "Hoje";
        break;
      case "amanha":
        deadline = endOfDay(1);
        periodoLabel = "Amanhã";
        break;
      case "semana":
        deadline = endOfWeek();
        periodoLabel = "Esta Semana";
        break;
      case "mes":
        deadline = endOfMonth();
        periodoLabel = "Este Mês";
        break;
    }

    // Aplica filtro: se tem próximo ep no período, ou mostra todos
    let filtered = all;
    if (deadline !== null) {
      filtered = all.filter(
        (m) =>
          m.nextAiringEpisode &&
          m.nextAiringEpisode.airingAt >= now &&
          m.nextAiringEpisode.airingAt <= deadline!
      );
    }

    // Ordena: com próximo ep primeiro (mais próximo primeiro), depois sem ep agendado
    filtered.sort((a, b) => {
      const aAt = a.nextAiringEpisode?.airingAt ?? Infinity;
      const bAt = b.nextAiringEpisode?.airingAt ?? Infinity;
      return aAt - bAt;
    });

    if (!filtered.length) {
      await interaction.editReply(
        `❌ Nenhum anime +18 com episódio previsto para **${periodoLabel}** encontrado.`
      );
      return;
    }

    const color = filtered[0]?.coverImage.color
      ? parseInt(filtered[0].coverImage.color.replace("#", ""), 16)
      : 0xc0392b;

    const lines = filtered.slice(0, 20).map((m, i) => {
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

    const embed = new EmbedBuilder()
      .setTitle(`🔞 Calendário +18 — ${periodoLabel}`)
      .setDescription(
        `⚠️ **Conteúdo adulto.** Títulos marcados como +18 pelo AniList.\n\n` +
        lines.join("\n\n").slice(0, 3800)
      )
      .setColor(color)
      .setFooter({
        text: `${filtered.length} título(s) • Horários em horário de Brasília • Fonte: AniList (isAdult)`,
      });

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar o calendário +18. Tente novamente.");
  }
}
