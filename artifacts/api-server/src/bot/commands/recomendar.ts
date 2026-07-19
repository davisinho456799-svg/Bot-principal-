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
import { buildScanLinksExternal } from "./search.js";

const ANILIST_API = "https://graphql.anilist.co";

interface GenreOption {
  label: string;
  value: string;
  emoji: string;
}

// 21 gêneros — 4 rows de 5 + última row com 1 gênero + botões de ação
const GENRES: GenreOption[] = [
  { label: "Ação",         value: "Action",       emoji: "⚔️" },
  { label: "Aventura",     value: "Adventure",    emoji: "🗺️" },
  { label: "Comédia",      value: "Comedy",       emoji: "😂" },
  { label: "Drama",        value: "Drama",        emoji: "😢" },
  { label: "Fantasia",     value: "Fantasy",      emoji: "🧙" },
  { label: "Horror",       value: "Horror",       emoji: "😱" },
  { label: "Mistério",     value: "Mystery",      emoji: "🔍" },
  { label: "Psicológico",  value: "Psychological",emoji: "🧠" },
  { label: "Romance",      value: "Romance",      emoji: "💕" },
  { label: "Sci-Fi",       value: "Sci-Fi",       emoji: "🚀" },
  { label: "Slice of Life",value: "Slice of Life",emoji: "☕" },
  { label: "Mecha",        value: "Mecha",        emoji: "🤖" },
  { label: "Mahou Shoujo", value: "Mahou Shoujo", emoji: "🌟" },
  { label: "Ecchi",        value: "Ecchi",        emoji: "💋" },
  { label: "Super Poder",  value: "Super Power",  emoji: "🦸" },
  { label: "Gore",         value: "Gore",         emoji: "🩸" },
  { label: "Reencarnação", value: "Reincarnation",emoji: "⏰" },
  { label: "Game",         value: "Video Games",  emoji: "🎮" },
  { label: "Zumbi",        value: "Zombies",      emoji: "🧟" },
  { label: "Survival",     value: "Survival",     emoji: "🗡️" },
  { label: "Escola",       value: "School Life",  emoji: "🏫" },
];

const ID_ADULT  = "rec_adult18";
const ID_CLEAR  = "rec_clear";
const ID_SEARCH = "rec_search";

// Query padrão — filtra por origem KR e score ≥ 70
const RECOMMEND_QUERY = `
query RecommendManhwa($genres: [String], $page: Int) {
  Page(page: $page, perPage: 6) {
    media(
      type: MANGA
      countryOfOrigin: KR
      genre_in: $genres
      sort: SCORE_DESC
      averageScore_greater: 70
    ) {
      id
      title { romaji english native }
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      chapters
      status
      siteUrl
      startDate { year month day }
    }
  }
}
`;

// Query +18 — sem filtro de origem, inclui Ecchi, score ≥ 60
const RECOMMEND_ADULT_QUERY = `
query RecommendAdult($genres: [String], $page: Int) {
  Page(page: $page, perPage: 6) {
    media(
      type: MANGA
      genre_in: $genres
      sort: SCORE_DESC
      averageScore_greater: 60
    ) {
      id
      title { romaji english native }
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      chapters
      status
      siteUrl
      startDate { year month day }
    }
  }
}
`;

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  description: string | null;
  coverImage: { large: string; color: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null };
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

async function fetchRecommendations(
  genres: string[],
  isAdult: boolean
): Promise<AniListMedia[]> {
  // Modo +18: usa query sem restrição de origem e inclui Ecchi automaticamente
  let finalGenres: string[] | null;
  let query: string;

  if (isAdult) {
    const adultGenres = new Set(genres);
    adultGenres.add("Ecchi");
    finalGenres = [...adultGenres];
    query = RECOMMEND_ADULT_QUERY;
  } else {
    finalGenres = genres.length > 0 ? genres : null;
    query = RECOMMEND_QUERY;
  }

  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query,
      variables: { genres: finalGenres, page: 1 },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { media: AniListMedia[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data.Page.media ?? [];
}

async function buildEmbed(
  results: AniListMedia[],
  selected: Set<string>,
  isAdult: boolean
): Promise<EmbedBuilder> {
  const genreLabels = [...selected]
    .map((v) => {
      const g = GENRES.find((x) => x.value === v);
      return g ? `${g.emoji} ${g.label}` : v;
    })
    .join(", ") || "Todos os gêneros";

  const lines = await Promise.all(
    results.map(async (m) => {
      const title = m.title.english ?? m.title.romaji ?? "Sem título";
      const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
      const chapters = m.chapters ? `📖 ${m.chapters} caps` : "";
      const status = statusLabel(m.status);
      const rawDesc = cleanDesc(m.description);
      const desc = rawDesc ? await translateToPtBr(rawDesc.slice(0, 200)) : "Sem sinopse.";
      const shortDesc = desc.slice(0, 120) + (desc.length > 120 ? "..." : "");
      const scanLinks = buildScanLinksExternal(title);
      return `**[${title}](${m.siteUrl})** — ${score} ${chapters ? `| ${chapters}` : ""} | ${status}\n> ${shortDesc}\n> 🔎 ${scanLinks}`;
    })
  );

  return new EmbedBuilder()
    .setTitle(isAdult ? "🔞 Recomendações +18 de Manhwa" : "📚 Recomendações de Manhwa")
    .setDescription(`**Gêneros:** ${genreLabels}\n\n${lines.join("\n\n")}`)
    .setColor(isAdult ? 0xff4444 : 0x7b68ee)
    .setFooter({ text: "Fonte: AniList • Sinopses traduzidas automaticamente" });
}

// Constrói as 5 linhas de botões com estado atual
function buildRows(
  selected: Set<string>,
  isAdult: boolean
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Rows 1–4: 5 gêneros cada
  for (let i = 0; i < 20; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        GENRES.slice(i, i + 5).map((g) =>
          new ButtonBuilder()
            .setCustomId(`rec_genre_${g.value}`)
            .setLabel(g.label)
            .setEmoji(g.emoji)
            .setStyle(selected.has(g.value) ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
      )
    );
  }

  // Row 5: último gênero (Escola) + botões de ação
  const lastGenre = GENRES[20];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rec_genre_${lastGenre.value}`)
        .setLabel(lastGenre.label)
        .setEmoji(lastGenre.emoji)
        .setStyle(selected.has(lastGenre.value) ? ButtonStyle.Primary : ButtonStyle.Secondary),
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

function isNsfwChannel(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
  const ch = interaction.channel;
  return !!(ch && "nsfw" in ch && (ch as TextChannel).nsfw);
}

export const data = new SlashCommandBuilder()
  .setName("recomendar")
  .setDescription("Recomenda manhwas por gênero — clique nos gêneros e depois em Buscar");

export async function execute(interaction: ChatInputCommandInteraction) {
  const selected = new Set<string>();
  let isAdult = false;

  await interaction.reply({
    content: "🎭 **Selecione os gêneros** clicando nos botões abaixo e depois clique em **Buscar**:",
    components: buildRows(selected, isAdult),
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      (i.customId.startsWith("rec_genre_") ||
        i.customId === ID_ADULT ||
        i.customId === ID_CLEAR ||
        i.customId === ID_SEARCH) &&
      i.user.id === interaction.user.id,
    time: 120_000,
  });

  collector?.on("collect", async (btn: ButtonInteraction) => {
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
      await btn.update({ components: buildRows(selected, isAdult) });
      return;
    }

    // ── Limpar ────────────────────────────────────────────────────────────────
    if (btn.customId === ID_CLEAR) {
      selected.clear();
      isAdult = false;
      await btn.update({
        content: "🎭 **Selecione os gêneros** clicando nos botões abaixo e depois clique em **Buscar**:",
        components: buildRows(selected, isAdult),
      });
      return;
    }

    // ── Buscar ────────────────────────────────────────────────────────────────
    if (btn.customId === ID_SEARCH) {
      collector.stop("searched");
      await btn.update({
        content: "⏳ Buscando recomendações...",
        components: [],
      });

      try {
        const results = await fetchRecommendations([...selected], isAdult);

        if (!results.length) {
          await interaction.editReply({
            content: "❌ Nenhum manhwa encontrado para essa combinação. Tente outros gêneros!",
          });
          return;
        }

        const embed = await buildEmbed(results, selected, isAdult);
        await interaction.editReply({ content: null, embeds: [embed] });
      } catch {
        await interaction.editReply({
          content: "❌ Erro ao buscar recomendações. Tente novamente.",
        });
      }
      return;
    }

    // ── Toggle de gênero ──────────────────────────────────────────────────────
    const genreValue = btn.customId.replace("rec_genre_", "");
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
        content: "⏱️ Tempo esgotado. Use `/recomendar` novamente.",
        components: [],
      });
    }
  });
}
