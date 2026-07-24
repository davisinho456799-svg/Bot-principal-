/**
 * Comando /calendario — lançamentos de episódios de anime hoje, amanhã, semana ou mês.
 * Fonte: AniList airingSchedule (gratuito, sem auth).
 */

import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

const AIRING_QUERY = `
query AiringSchedule($airingAtGreater: Int, $airingAtLesser: Int) {
  Page(page: 1, perPage: 25) {
    airingSchedules(
      airingAt_greater: $airingAtGreater
      airingAt_lesser: $airingAtLesser
      sort: TIME
    ) {
      airingAt
      episode
      media {
        id
        title { romaji english }
        genres
        averageScore
        siteUrl
        type
        coverImage { color }
      }
    }
  }
}
`;

interface AiringEntry {
  airingAt: number;
  episode: number;
  media: {
    id: number;
    title: { romaji: string; english: string | null };
    genres: string[];
    averageScore: number | null;
    siteUrl: string;
    type: string;
    coverImage: { color: string | null };
  };
}

// ─── Helpers de tempo ─────────────────────────────────────────────────────────

function dayRange(offsetDays = 0): { start: number; end: number } {
  const now = new Date();
  // Início do dia alvo (meia-noite UTC)
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  const end = new Date(start.getTime() + 86_400_000 - 1); // 23:59:59.999
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function weekRange(): { start: number; end: number } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 7 * 86_400_000 - 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function monthRange(): { start: number; end: number } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Busca ────────────────────────────────────────────────────────────────────

async function fetchAiring(start: number, end: number): Promise<AiringEntry[]> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: AIRING_QUERY,
      variables: { airingAtGreater: start, airingAtLesser: end },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { airingSchedules: AiringEntry[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data.Page.airingSchedules ?? [];
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("calendario")
  .setDescription("Mostra os episódios de anime que estreiam hoje, amanhã, na semana ou no mês")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Período de exibição")
      .setRequired(false)
      .addChoices(
        { name: "Hoje", value: "hoje" },
        { name: "Amanhã", value: "amanha" },
        { name: "Esta semana (7 dias)", value: "semana" },
        { name: "Este mês", value: "mes" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "hoje";
  await interaction.deferReply();

  let range: { start: number; end: number };
  let titulo: string;
  let emoji: string;

  switch (periodo) {
    case "amanha":
      range = dayRange(1);
      titulo = "Amanhã";
      emoji = "📅";
      break;
    case "semana":
      range = weekRange();
      titulo = "Esta Semana";
      emoji = "🗓️";
      break;
    case "mes":
      range = monthRange();
      titulo = "Este Mês";
      emoji = "📆";
      break;
    default:
      range = dayRange(0);
      titulo = "Hoje";
      emoji = "📺";
  }

  try {
    const entries = await fetchAiring(range.start, range.end);

    if (!entries.length) {
      await interaction.editReply(
        `${emoji} Nenhum episódio de anime encontrado para **${titulo}** no calendário AniList.`
      );
      return;
    }

    // Cor dominante do primeiro resultado (fallback azul)
    const color = entries[0]?.media.coverImage.color
      ? parseInt(entries[0].media.coverImage.color.replace("#", ""), 16)
      : 0x02a9ff;

    const lines = entries.slice(0, 20).map((e) => {
      const name = e.media.title.english ?? e.media.title.romaji;
      const score = e.media.averageScore ? ` ⭐${(e.media.averageScore / 10).toFixed(1)}` : "";
      const genres = e.media.genres.slice(0, 2).join(", ");
      const time = formatTime(e.airingAt);
      return `**Ep ${e.episode}** — [${name}](${e.media.siteUrl})${score}\n> 🕐 ${time} | 🏷️ ${genres || "—"}`;
    });

    // Agrupa por dia se for semana/mês
    const description = lines.join("\n\n");

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} Calendário de Anime — ${titulo}`)
      .setDescription(description.slice(0, 4000))
      .setColor(color)
      .setFooter({
        text: `${entries.length} episódio(s) encontrado(s) • Horários em horário de Brasília • Fonte: AniList`,
      });

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar o calendário. Tente novamente em instantes.");
  }
}
