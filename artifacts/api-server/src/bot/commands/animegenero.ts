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
import { translateToPtBr, statusLabel } from "../anilist.js";

const ANILIST_API = "https://graphql.anilist.co";

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
  { label: "Gore",          value: "Gore",          emoji: "🩸",  kind: "tag"   },
  { label: "Reencarnação",  value: "Reincarnation", emoji: "⏰",  kind: "tag"   },
  { label: "Escola",        value: "School Life",   emoji: "🏫",  kind: "tag"   },
  { label: "Survival",      value: "Survival",      emoji: "🗡️",  kind: "tag"   },
  { label: "Harém",         value: "Harem",         emoji: "💌",  kind: "tag"   },
];

const ID_ADULT  = "ag_adult18";
const ID_CLEAR  = "ag_clear";
const ID_SEARCH = "ag_search";

// Query normal (sem isAdult)
const ANIME_GENRE_QUERY = `
query AnimeByGenre($genres: [String], $tags: [String], $page: Int) {
  Page(page: $page, perPage: 6) {
    media(
      type: ANIME
      genre_in: $genres
      tag_in: $tags
      sort: POPULARITY_DESC
      isAdult: false
    ) {
      id
      title { romaji english native }
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      episodes
      status
      siteUrl
      season
      seasonYear
      externalLinks { url site type }
    }
  }
}
`;

// Query +18
const ANIME_ADULT_QUERY = `
query AnimeAdult($genres: [String], $tags: [String], $page: Int) {
  Page(page: $page, perPage: 6) {
    media(
      type: ANIME
      genre_in: $genres
      tag_in: $tags
      sort: POPULARITY_DESC
      isAdult: true
    ) {
      id
      title { romaji english native }
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      episodes
      status
      siteUrl
      season
      seasonYear
      externalLinks { url site type }
    }
  }
}
`;

interface AnimeMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  description: string | null;
  coverImage: { large: string; color: string | null };
  averageScore: number | null;
  genres: string[];
  episodes: number | null;
  status: string | null;
  siteUrl: string;
  season: string | null;
  seasonYear: number | null;
  externalLinks: Array<{ url: string; site: string; type: string }>;
}

function cleanDesc(raw: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

function getStreamingLinks(links: Array<{ url: string; site: string; type: string }>): string {
  const sites = links
    .filter(
      (l) =>
        l.type === "STREAMING" ||
        ["Crunchyroll", "Funimation", "Netflix", "Disney Plus", "Amazon Prime Video", "HIDIVE"].includes(l.site)
    )
    .slice(0, 3);
  if (!sites.length) return "";
  return sites.map((l) => `[${l.site}](${l.url})`).join(" • ");
}

function seasonLabel(season: string | null, year: number | null): string {
  const map: Record<string, string> = {
    WINTER: "Inverno", SPRING: "Primavera", SUMMER: "Verão", FALL: "Outono",
  };
  if (!season) return year ? String(year) : "";
  return `${map[season] ?? season} ${year ?? ""}`.trim();
}

async function fetchAnime(selected: Set<string>, isAdult: boolean): Promise<AnimeMedia[]> {
  const genreValues = [...selected].filter(
    (v) => GENRES.find((g) => g.value === v)?.kind === "genre"
  );
  const tagValues = [...selected].filter(
    (v) => GENRES.find((g) => g.value === v)?.kind === "tag"
  );

  const variables: Record<string, unknown> = { page: 1 };
  if (genreValues.length > 0) variables["genres"] = genreValues;
  if (tagValues.length > 0) variables["tags"] = tagValues;

  const query = isAdult ? ANIME_ADULT_QUERY : ANIME_GENRE_QUERY;

  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { media: AnimeMedia[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data.Page.media ?? [];
}

async function buildEmbed(results: AnimeMedia[], selected: Set<string>, isAdult: boolean): Promise<EmbedBuilder> {
  const genreLabels =
    [...selected]
      .map((v) => {
        const g = GENRES.find((x) => x.value === v);
        return g ? `${g.emoji} ${g.label}` : v;
      })
      .join(", ") || "Todos os gêneros";

  const lines = await Promise.all(
    results.map(async (m) => {
      const title = m.title.english ?? m.title.romaji ?? "Sem título";
      const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
      const eps = m.episodes ? `📺 ${m.episodes} eps` : "📺 Em andamento";
      const season = seasonLabel(m.season, m.seasonYear);
      const rawDesc = cleanDesc(m.description);
      const desc = rawDesc
        ? await translateToPtBr(rawDesc.slice(0, 200)).catch(() => rawDesc.slice(0, 120))
        : "Sem sinopse.";
      const shortDesc = desc.slice(0, 120) + (desc.length > 120 ? "..." : "");
      const streaming = getStreamingLinks(m.externalLinks);
      const status = statusLabel(m.status);

      let line = `**[${title}](${m.siteUrl})** — ${score} | ${eps} | ${status}`;
      if (season) line += ` | 🎬 ${season}`;
      line += `\n> ${shortDesc}`;
      if (streaming) line += `\n> 📺 ${streaming}`;
      return line;
    })
  );

  return new EmbedBuilder()
    .setTitle(isAdult ? "🔞 Animes +18 por Gênero" : "🎌 Animes por Gênero")
    .setDescription(`**Gêneros:** ${genreLabels}\n\n${lines.join("\n\n")}`.slice(0, 4000))
    .setColor(isAdult ? 0xff4444 : 0xe74c3c)
    .setFooter({ text: "Fonte: AniList • Sinopses traduzidas automaticamente" });
}

function buildRows(selected: Set<string>, isAdult: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Gêneros em grupos de 5 (máx 4 linhas de gêneros = 20 botões)
  for (let i = 0; i < 20; i += 5) {
    const slice = GENRES.slice(i, i + 5);
    if (slice.length === 0) break;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        slice.map((g) =>
          new ButtonBuilder()
            .setCustomId(`ag_genre_${g.value}`)
            .setLabel(g.label)
            .setEmoji(g.emoji)
            .setStyle(selected.has(g.value) ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
      )
    );
  }

  // Última linha: gênero 21 + controles
  const last = GENRES[20];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ag_genre_${last.value}`)
        .setLabel(last.label)
        .setEmoji(last.emoji)
        .setStyle(selected.has(last.value) ? ButtonStyle.Primary : ButtonStyle.Secondary),
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

function isNsfwChannel(btn: ButtonInteraction): boolean {
  const ch = btn.channel;
  return !!(ch && "nsfw" in ch && (ch as TextChannel).nsfw);
}

export const data = new SlashCommandBuilder()
  .setName("animegenero")
  .setDescription("Busca animes por gênero — normal e +18 (em canais NSFW)");

export async function execute(interaction: ChatInputCommandInteraction) {
  const selected = new Set<string>();
  let isAdult = false;

  await interaction.reply({
    content: "🎌 **Selecione os gêneros** clicando nos botões e depois clique em **Buscar**:",
    components: buildRows(selected, isAdult),
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      (i.customId.startsWith("ag_genre_") ||
        i.customId === ID_ADULT ||
        i.customId === ID_CLEAR ||
        i.customId === ID_SEARCH) &&
      i.user.id === interaction.user.id,
    time: 120_000,
  });

  collector?.on("collect", async (btn: ButtonInteraction) => {

    // +18
    if (btn.customId === ID_ADULT) {
      if (!isNsfwChannel(btn)) {
        await btn.reply({
          content: "🔞 O filtro **+18** só pode ser ativado em canais marcados como **NSFW**.",
          ephemeral: true,
        });
        return;
      }
      isAdult = !isAdult;
      await btn.update({ components: buildRows(selected, isAdult) });
      return;
    }

    // Limpar
    if (btn.customId === ID_CLEAR) {
      selected.clear();
      isAdult = false;
      await btn.update({
        content: "🎌 **Selecione os gêneros** clicando nos botões e depois clique em **Buscar**:",
        components: buildRows(selected, isAdult),
      });
      return;
    }

    // Buscar
    if (btn.customId === ID_SEARCH) {
      collector.stop("searched");
      await btn.deferUpdate();
      await interaction.editReply({
        content: "⏳ Buscando animes...",
        components: [],
      });

      try {
        const results = await fetchAnime(selected, isAdult);

        if (!results.length) {
          await interaction.editReply({
            content: "❌ Nenhum anime encontrado para essa combinação. Tente outros gêneros!",
          });
          return;
        }

        const embed = await buildEmbed(results, selected, isAdult);
        await interaction.editReply({ content: "", embeds: [embed] });
      } catch (err) {
        console.error("[animegenero] Erro:", err);
        await interaction.editReply({
          content: "❌ Erro ao buscar animes. Tente novamente.",
        });
      }
      return;
    }

    // Toggle gênero
    const genreValue = btn.customId.replace("ag_genre_", "");
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

    await btn.update({ components: buildRows(selected, isAdult) });
  });

  collector?.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await interaction.editReply({
        content: "⏱️ Tempo esgotado. Use `/animegenero` novamente.",
        components: [],
      });
    }
  });
}
