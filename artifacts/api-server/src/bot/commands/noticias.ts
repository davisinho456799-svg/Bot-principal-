import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
  TextChannel,
} from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

// Sites de notícias de anime
const NEWS_SITES = [
  { name: "ANN", url: "https://www.animenewsnetwork.com/search?q=" },
  { name: "Crunchyroll", url: "https://www.crunchyroll.com/search?q=" },
  { name: "MAL", url: "https://myanimelist.net/search/all?q=" },
];

interface GenreOption {
  label: string;
  value: string;
  emoji: string;
  kind: "genre" | "tag";
}

const GENRES: GenreOption[] = [
  { label: "Ação",          value: "Action",        emoji: "⚔️",  kind: "genre" },
  { label: "Aventura",      value: "Adventure",     emoji: "🗺️",  kind: "genre" },
  { label: "Comédia",       value: "Comedy",        emoji: "😂",  kind: "genre" },
  { label: "Drama",         value: "Drama",         emoji: "😢",  kind: "genre" },
  { label: "Fantasia",      value: "Fantasy",       emoji: "🧙",  kind: "genre" },
  { label: "Horror",        value: "Horror",        emoji: "😱",  kind: "genre" },
  { label: "Mistério",      value: "Mystery",       emoji: "🔍",  kind: "genre" },
  { label: "Psicológico",   value: "Psychological", emoji: "🧠",  kind: "genre" },
  { label: "Romance",       value: "Romance",       emoji: "💕",  kind: "genre" },
  { label: "Sci-Fi",        value: "Sci-Fi",        emoji: "🚀",  kind: "genre" },
  { label: "Slice of Life", value: "Slice of Life", emoji: "☕",  kind: "genre" },
  { label: "Esportes",      value: "Sports",        emoji: "⚽",  kind: "genre" },
  { label: "Sobrenatural",  value: "Supernatural",  emoji: "👻",  kind: "genre" },
  { label: "Mecha",         value: "Mecha",         emoji: "🤖",  kind: "genre" },
  { label: "Ecchi",         value: "Ecchi",         emoji: "💋",  kind: "genre" },
  // Tags
  { label: "Super Poder",   value: "Super Power",   emoji: "🦸",  kind: "tag"   },
  { label: "Reencarnação",  value: "Reincarnation", emoji: "⏰",  kind: "tag"   },
  { label: "Escola",        value: "School Life",   emoji: "🏫",  kind: "tag"   },
  { label: "Survival",      value: "Survival",      emoji: "🗡️",  kind: "tag"   },
  { label: "Harém",         value: "Harem",         emoji: "💌",  kind: "tag"   },
];

const ID_ADULT  = "nt_adult18";
const ID_CLEAR  = "nt_clear";
const ID_SEARCH = "nt_search";

// Busca animes que estão lançando ou prestes a lançar, filtrados por gênero
const UPCOMING_GENRE_QUERY = `
query UpcomingByGenre($genres: [String], $tags: [String], $page: Int, $isAdult: Boolean) {
  Page(page: $page, perPage: 8) {
    media(
      type: ANIME
      genre_in: $genres
      tag_in: $tags
      status_in: [NOT_YET_RELEASED, RELEASING]
      sort: POPULARITY_DESC
      isAdult: $isAdult
    ) {
      id
      title { romaji english native }
      episodes
      status
      season
      seasonYear
      startDate { year month day }
      nextAiringEpisode { airingAt episode }
      coverImage { color }
      genres
      averageScore
      siteUrl
      externalLinks { url site type }
    }
  }
}
`;

// Sem filtro de gênero — mostra os mais populares em lançamento
const UPCOMING_ALL_QUERY = `
query UpcomingAll($page: Int, $isAdult: Boolean) {
  Page(page: $page, perPage: 8) {
    media(
      type: ANIME
      status_in: [NOT_YET_RELEASED, RELEASING]
      sort: POPULARITY_DESC
      isAdult: $isAdult
    ) {
      id
      title { romaji english native }
      episodes
      status
      season
      seasonYear
      startDate { year month day }
      nextAiringEpisode { airingAt episode }
      coverImage { color }
      genres
      averageScore
      siteUrl
      externalLinks { url site type }
    }
  }
}
`;

interface ExternalLink { url: string; site: string; type: string; }
interface AiringEp { airingAt: number; episode: number; }

interface AnimeMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  episodes: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  nextAiringEpisode: AiringEp | null;
  coverImage: { color: string | null };
  genres: string[];
  averageScore: number | null;
  siteUrl: string;
  externalLinks: ExternalLink[] | null;
}

function seasonLabel(season: string | null, year: number | null): string {
  const map: Record<string, string> = {
    WINTER: "Inverno", SPRING: "Primavera", SUMMER: "Verão", FALL: "Outono",
  };
  if (!season) return year ? String(year) : "";
  return `${map[season] ?? season} ${year ?? ""}`.trim();
}

function formatDate(airingAt: number | null, startDate: AnimeMedia["startDate"]): string {
  if (airingAt) {
    const d = new Date(airingAt * 1000);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  if (startDate?.year) {
    if (startDate.day && startDate.month)
      return `${String(startDate.day).padStart(2, "0")}/${String(startDate.month).padStart(2, "0")}/${startDate.year}`;
    if (startDate.month)
      return `${String(startDate.month).padStart(2, "0")}/${startDate.year}`;
    return String(startDate.year);
  }
  return "Em breve";
}

function getStreamingLinks(links: ExternalLink[] | null | undefined): string {
  const sites = (links ?? [])
    .filter(
      (l) =>
        l.type === "STREAMING" ||
        ["Crunchyroll", "Funimation", "Netflix", "Disney Plus", "Amazon Prime Video", "HIDIVE"].includes(l.site)
    )
    .slice(0, 3);
  return sites.map((l) => `[${l.site}](${l.url})`).join(" • ");
}

function buildNewsLinks(title: string): string {
  const q = encodeURIComponent(title);
  return NEWS_SITES.map((s) => `[${s.name}](${s.url}${q})`).join(" • ");
}

async function fetchAnime(selected: Set<string>, isAdult: boolean, page: number): Promise<AnimeMedia[]> {
  const genreValues = [...selected].filter(
    (v) => GENRES.find((g) => g.value === v)?.kind === "genre"
  );
  const tagValues = [...selected].filter(
    (v) => GENRES.find((g) => g.value === v)?.kind === "tag"
  );

  const hasFilters = genreValues.length > 0 || tagValues.length > 0;
  let body: Record<string, unknown>;

  if (hasFilters) {
    const variables: Record<string, unknown> = { page, isAdult };
    if (genreValues.length > 0) variables["genres"] = genreValues;
    if (tagValues.length > 0) variables["tags"] = tagValues;
    body = { query: UPCOMING_GENRE_QUERY, variables };
  } else {
    body = { query: UPCOMING_ALL_QUERY, variables: { page, isAdult } };
  }

  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { Page?: { media?: AnimeMedia[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data?.Page?.media ?? [];
}

function buildEmbed(media: AnimeMedia[], selected: Set<string>, isAdult: boolean, page: number): EmbedBuilder {
  const genreLabels =
    [...selected]
      .map((v) => {
        const g = GENRES.find((x) => x.value === v);
        return g ? `${g.emoji} ${g.label}` : v;
      })
      .join(", ") || "Todos os gêneros";

  const lines = media.map((m, i) => {
    const title = m.title.english ?? m.title.romaji ?? "Sem título";
    const date = formatDate(m.nextAiringEpisode?.airingAt ?? null, m.startDate);
    const eps = m.episodes ? `${m.episodes} eps` : "? eps";
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "";
    const season = seasonLabel(m.season, m.seasonYear);
    const genres = m.genres.slice(0, 3).join(", ") || "—";
    const streaming = getStreamingLinks(m.externalLinks);
    const newsLinks = buildNewsLinks(title);

    let line = `**${i + 1}.** [${title}](${m.siteUrl}) — 📅 ${date} | ${eps}`;
    if (score) line += ` | ${score}`;
    if (season) line += `\n> 🎬 ${season}`;
    line += ` • 🏷️ ${genres}`;
    if (streaming) line += `\n> 📺 ${streaming}`;
    line += `\n> 📰 ${newsLinks}`;
    return line;
  });

  const embedTitle = isAdult ? "🔞 Notícias de Animes +18" : "📡 Notícias de Animes";
  const header = `**Gêneros:** ${genreLabels}\n\n`;
  const maxBody = 4000 - header.length;

  // Junta linhas completas sem cortar no meio de um link
  let body = "";
  for (const line of lines) {
    const chunk = (body ? "\n\n" : "") + line;
    if (body.length + chunk.length > maxBody) break;
    body += chunk;
  }

  return new EmbedBuilder()
    .setTitle(embedTitle)
    .setDescription(header + (body || "Nenhum resultado."))

    .setColor(isAdult ? 0xff4444 : 0x3498db)
    .setFooter({ text: `Fonte: AniList • Página ${page} • Status: Lançando / Em breve` });
}

function buildGenreRows(selected: Set<string>, isAdult: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Linhas de gêneros (5 por linha)
  for (let i = 0; i < GENRES.length; i += 5) {
    const slice = GENRES.slice(i, i + 5);
    if (!slice.length) break;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        slice.map((g) =>
          new ButtonBuilder()
            .setCustomId(`nt_genre_${g.value}`)
            .setLabel(g.label)
            .setEmoji(g.emoji)
            .setStyle(selected.has(g.value) ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
      )
    );
  }

  // Última linha: apenas controles (+18, Limpar, Buscar)
  // O loop acima já cobre todos os 20 gêneros (índices 0-19)
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ID_ADULT)
        .setLabel("+18")
        .setEmoji("🔞")
        .setStyle(isAdult ? ButtonStyle.Danger : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ID_CLEAR)
        .setLabel("Limpar")
        .setEmoji("🧹")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ID_SEARCH)
        .setLabel("Buscar")
        .setEmoji("🔍")
        .setStyle(ButtonStyle.Success)
    )
  );

  return rows;
}

function buildNavRow(page: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("nt_prev")
      .setLabel("◀ Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId("nt_next")
      .setLabel("Próxima ▶")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("nt_back")
      .setLabel("🔄 Mudar Gêneros")
      .setStyle(ButtonStyle.Primary)
  );
}

function isNsfwChannel(btn: ButtonInteraction): boolean {
  const ch = btn.channel;
  return !!(ch && "nsfw" in ch && (ch as TextChannel).nsfw);
}

export const data = new SlashCommandBuilder()
  .setName("noticias")
  .setDescription("Notícias de animes que vão lançar — filtre por gênero e veja links de streaming e notícias");

export async function execute(interaction: ChatInputCommandInteraction) {
  const selected = new Set<string>();
  let isAdult = false;
  let page = 1;
  let phase: "picking" | "results" = "picking";

  // Fase 1: seleção de gêneros
  await interaction.reply({
    content: "📡 **Notícias de Animes**\nSelecione os gêneros para filtrar (opcional) e clique em **Buscar**:",
    components: buildGenreRows(selected, isAdult),
  });

  if (!interaction.channel) {
    await interaction.editReply({ content: "❌ Não foi possível iniciar o coletor de botões neste canal.", components: [] });
    return;
  }

  const collector = interaction.channel.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      (i.customId.startsWith("nt_genre_") ||
        [ID_ADULT, ID_CLEAR, ID_SEARCH, "nt_prev", "nt_next", "nt_back"].includes(i.customId)) &&
      i.user.id === interaction.user.id,
    time: 180_000,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    try {

    // ── +18 ──────────────────────────────────────────────────────────────────
    if (btn.customId === ID_ADULT) {
      if (!isNsfwChannel(btn)) {
        await btn.reply({
          content: "🔞 O filtro **+18** só pode ser ativado em canais marcados como **NSFW**.",
          ephemeral: true,
        });
        return;
      }
      isAdult = !isAdult;
      await btn.update({ components: buildGenreRows(selected, isAdult) });
      return;
    }

    // ── Limpar ────────────────────────────────────────────────────────────────
    if (btn.customId === ID_CLEAR) {
      selected.clear();
      isAdult = false;
      await btn.update({
        content: "📡 **Notícias de Animes**\nSelecione os gêneros para filtrar (opcional) e clique em **Buscar**:",
        components: buildGenreRows(selected, isAdult),
      });
      return;
    }

    // ── Buscar ────────────────────────────────────────────────────────────────
    if (btn.customId === ID_SEARCH) {
      await btn.deferUpdate();
      await interaction.editReply({ content: "⏳ Buscando notícias...", components: [] });

      try {
        const media = await fetchAnime(selected, isAdult, 1);

        if (!media.length) {
          // Volta para seleção de gêneros em vez de deixar o usuário preso
          await interaction.editReply({
            content: "❌ Nenhum anime encontrado para esses gêneros. Tente outros!\n\n📡 **Notícias de Animes**\nSelecione os gêneros para filtrar (opcional) e clique em **Buscar**:",
            embeds: [],
            components: buildGenreRows(selected, isAdult),
          });
          return;
        }

        phase = "results";
        page = 1;
        await interaction.editReply({
          content: "",
          embeds: [buildEmbed(media, selected, isAdult, page)],
          components: [buildNavRow(page)],
        });
      } catch (err) {
        console.error("[noticias] Erro ao buscar:", err);
        // Volta para seleção em vez de deixar sem botões
        await interaction.editReply({
          content: "❌ Erro ao buscar. Tente novamente!\n\n📡 **Notícias de Animes**\nSelecione os gêneros para filtrar (opcional) e clique em **Buscar**:",
          embeds: [],
          components: buildGenreRows(selected, isAdult),
        });
      }
      return;
    }

    // ── Voltar para seleção de gêneros ────────────────────────────────────────
    if (btn.customId === "nt_back") {
      phase = "picking";
      page = 1;
      await btn.update({
        content: "📡 **Notícias de Animes**\nSelecione os gêneros para filtrar (opcional) e clique em **Buscar**:",
        embeds: [],
        components: buildGenreRows(selected, isAdult),
      });
      return;
    }

    // ── Paginação ─────────────────────────────────────────────────────────────
    if (phase === "results" && (btn.customId === "nt_prev" || btn.customId === "nt_next")) {
      const prevPage = page;
      if (btn.customId === "nt_prev") page = Math.max(1, page - 1);
      else page++;

      await btn.deferUpdate();
      try {
        const media = await fetchAnime(selected, isAdult, page);
        if (!media.length) {
          page = prevPage; // restaura estado se não houver resultados
          await btn.followUp({ content: "❌ Sem mais resultados nessa página.", ephemeral: true });
          return;
        }
        await interaction.editReply({
          embeds: [buildEmbed(media, selected, isAdult, page)],
          components: [buildNavRow(page)],
        });
      } catch {
        page = prevPage; // restaura estado em caso de erro
        await btn.followUp({ content: "❌ Erro ao paginar. Tente novamente.", ephemeral: true });
      }
      return;
    }

    // ── Toggle de gênero ──────────────────────────────────────────────────────
    if (phase === "picking") {
      const genreValue = btn.customId.replace("nt_genre_", "");
      if (selected.has(genreValue)) {
        selected.delete(genreValue);
      } else {
        if (selected.size >= 5) {
          await btn.reply({
            content: "⚠️ Você pode selecionar no máximo **5 gêneros** por vez.",
            ephemeral: true,
          });
          return;
        }
        selected.add(genreValue);
      }
      await btn.update({ components: buildGenreRows(selected, isAdult) });
    }

    } catch (err) {
      console.error("[noticias] Erro inesperado no handler:", err);
      // Tenta responder ao usuário se ainda não foi respondido
      try {
        if (!btn.replied && !btn.deferred) {
          await btn.reply({ content: "❌ Ocorreu um erro inesperado. Tente novamente.", ephemeral: true });
        }
      } catch {
        // Silencia erro de resposta duplicada
      }
    }
  });

  collector.on("end", async (_col, reason) => {
    if (reason === "time") {
      await interaction.editReply({ components: [] }).catch(() => null);
    }
  });
}
