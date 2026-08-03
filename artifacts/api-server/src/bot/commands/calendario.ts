/**
 * Comando /calendario — episódios de anime, capítulos de manga (JP) e manhwa (KR).
 * Fonte: AniList. Botões para alternar abas e paginar resultados (20 por página).
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  StringSelectMenuBuilder,
} from "discord.js";
import { db, assinaturasTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getUnifiedById } from "../unified.js";
import { logger } from "../../lib/logger.js";

const ANILIST_API = "https://graphql.anilist.co";
const PAGE_SIZE   = 20;

// ─── Queries ──────────────────────────────────────────────────────────────────

const AIRING_QUERY = `
query AiringSchedule($page: Int, $airingAtGreater: Int, $airingAtLesser: Int) {
  Page(page: $page, perPage: 25) {
    pageInfo { hasNextPage }
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
        coverImage { color }
      }
    }
  }
}
`;

const MANGA_BY_COUNTRY_QUERY = `
query MangaByCountry($page: Int, $country: CountryCode) {
  Page(page: $page, perPage: 25) {
    media(
      type: MANGA
      status: RELEASING
      countryOfOrigin: $country
      sort: UPDATED_AT_DESC
    ) {
      id
      title { romaji english }
      genres
      averageScore
      siteUrl
      coverImage { color }
      updatedAt
    }
  }
}
`;

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface AiringEntry {
  airingAt: number;
  episode: number;
  media: {
    id: number;
    title: { romaji: string; english: string | null };
    genres: string[];
    averageScore: number | null;
    siteUrl: string;
    coverImage: { color: string | null };
  };
}

interface MangaEntry {
  id: number;
  title: { romaji: string; english: string | null };
  genres: string[];
  averageScore: number | null;
  siteUrl: string;
  coverImage: { color: string | null };
  updatedAt: number;
}

// ─── Helpers de tempo ─────────────────────────────────────────────────────────

function dayRange(offsetDays = 0): { start: number; end: number } {
  const now   = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  const end   = new Date(start.getTime() + 86_400_000 - 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function weekRange(): { start: number; end: number } {
  const now   = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end   = new Date(start.getTime() + 7 * 86_400_000 - 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function monthRange(): { start: number; end: number } {
  const now   = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// ─── Busca ────────────────────────────────────────────────────────────────────

async function fetchAiring(start: number, end: number): Promise<AiringEntry[]> {
  // Busca até 3 páginas em paralelo para cobrir semanas/meses com muitos episódios
  const pages = await Promise.allSettled(
    [1, 2, 3].map((page) =>
      fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: AIRING_QUERY, variables: { page, airingAtGreater: start, airingAtLesser: end } }),
        signal: AbortSignal.timeout(12000),
      }).then(async (r) => {
        if (!r.ok) return [];
        const j = (await r.json()) as {
          data: { Page: { airingSchedules: AiringEntry[]; pageInfo: { hasNextPage: boolean } } };
          errors?: unknown[];
        };
        return j.errors?.length ? [] : (j.data.Page.airingSchedules ?? []);
      }),
    ),
  );
  return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
}

async function fetchMangaByCountry(country: "JP" | "KR"): Promise<MangaEntry[]> {
  const pages = await Promise.allSettled(
    [1, 2, 3].map((page) =>
      fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: MANGA_BY_COUNTRY_QUERY, variables: { page, country } }),
        signal: AbortSignal.timeout(12000),
      }).then(async (r) => {
        if (!r.ok) return [];
        const j = (await r.json()) as { data: { Page: { media: MangaEntry[] } }; errors?: unknown[] };
        return j.errors?.length ? [] : (j.data.Page.media ?? []);
      }),
    ),
  );
  return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
}

// ─── Builders de embed ────────────────────────────────────────────────────────

function buildAnimeEmbed(entries: AiringEntry[], titulo: string, emoji: string, page: number): EmbedBuilder {
  const totalPages = Math.ceil(entries.length / PAGE_SIZE) || 1;
  const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const color = slice[0]?.media.coverImage.color
    ? parseInt(slice[0].media.coverImage.color.replace("#", ""), 16)
    : 0x02a9ff;

  const lines = slice.map((e) => {
    const name   = e.media.title.english ?? e.media.title.romaji;
    const score  = e.media.averageScore ? ` ⭐${(e.media.averageScore / 10).toFixed(1)}` : "";
    const genres = e.media.genres.slice(0, 2).join(", ");
    return `**Ep ${e.episode}** — [${name}](${e.media.siteUrl})${score}\n> 🕐 ${formatTime(e.airingAt)} | 🏷️ ${genres || "—"}`;
  });

  return new EmbedBuilder()
    .setTitle(`${emoji} Calendário de Anime — ${titulo}`)
    .setDescription(lines.length ? lines.join("\n\n").slice(0, 4000) : "_Nenhum episódio encontrado para esse período._")
    .setColor(color)
    .setFooter({ text: `Página ${page + 1}/${totalPages} • ${entries.length} episódio(s) • Horários de Brasília • Fonte: AniList` });
}

function buildComicEmbed(entries: MangaEntry[], type: "manga" | "manhwa", page: number): EmbedBuilder {
  const isManhwa   = type === "manhwa";
  const totalPages = Math.ceil(entries.length / PAGE_SIZE) || 1;
  const slice      = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const color      = slice[0]?.coverImage.color
    ? parseInt(slice[0].coverImage.color.replace("#", ""), 16)
    : isManhwa ? 0xe67e22 : 0x27ae60;

  const flag  = isManhwa ? "🇰🇷" : "🇯🇵";
  const label = isManhwa ? "Manhwa" : "Manga";
  const offset = page * PAGE_SIZE;

  const lines = slice.map((e, i) => {
    const title  = e.title.english ?? e.title.romaji;
    const score  = e.averageScore ? ` ⭐${(e.averageScore / 10).toFixed(1)}` : "";
    const genres = e.genres.slice(0, 2).join(", ");
    return (
      `**${offset + i + 1}.** [${title}](${e.siteUrl})${score}\n` +
      `> ${flag} ${label} | 🗓️ Atualizado: ${formatDate(e.updatedAt)} | 🏷️ ${genres || "—"}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`${flag} Calendário de ${label} — Atualizações Recentes`)
    .setDescription(lines.length ? lines.join("\n\n").slice(0, 4000) : `_Nenhum ${label.toLowerCase()} encontrado._`)
    .setColor(color)
    .setFooter({ text: `Página ${page + 1}/${totalPages} • ${entries.length} série(s) em lançamento • Fonte: AniList` });
}

// ─── Botões de aba e navegação ────────────────────────────────────────────────

type Tab = "anime" | "manga" | "manhwa";

const TAB_DEFS: { id: Tab; label: string }[] = [
  { id: "anime",  label: "📺 Anime"   },
  { id: "manga",  label: "🇯🇵 Manga"  },
  { id: "manhwa", label: "🇰🇷 Manhwa" },
];

function buildTabRow(active: Tab, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    TAB_DEFS.map((t) =>
      new ButtonBuilder()
        .setCustomId(`cal_${t.id}`)
        .setLabel(t.label)
        .setStyle(t.id === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );
}

/** Retorna null quando não há mais de uma página (sem necessidade de nav). */
function buildNavRow(page: number, total: number, prefix: string, disabled = false): ActionRowBuilder<ButtonBuilder> | null {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return null;

  const row = new ActionRowBuilder<ButtonBuilder>();
  const btns: ButtonBuilder[] = [];

  if (page > 0) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`${prefix}_prev`)
        .setLabel("⬅️ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }

  btns.push(
    new ButtonBuilder()
      .setCustomId(`${prefix}_page_indicator`)
      .setLabel(`Página ${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  if (page < totalPages - 1) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`${prefix}_next`)
        .setLabel("Próxima ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }

  return row.addComponents(btns);
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("calendario")
  .setDescription("Mostra episódios de anime, capítulos de manga (JP) ou manhwa (KR) em lançamento")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Período de exibição (aplica-se à aba de Anime)")
      .setRequired(false)
      .addChoices(
        { name: "Hoje",                 value: "hoje"   },
        { name: "Amanhã",               value: "amanha" },
        { name: "Esta semana (7 dias)", value: "semana" },
        { name: "Este mês",             value: "mes"    },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "hoje";
  await interaction.deferReply();

  let range: { start: number; end: number };
  let titulo: string;
  let emoji: string;

  switch (periodo) {
    case "amanha": range = dayRange(1);  titulo = "Amanhã";      emoji = "📅"; break;
    case "semana": range = weekRange();  titulo = "Esta Semana";  emoji = "🗓️"; break;
    case "mes":    range = monthRange(); titulo = "Este Mês";     emoji = "📆"; break;
    default:       range = dayRange(0);  titulo = "Hoje";         emoji = "📺";
  }

  // Busca as 3 abas em paralelo
  const [animeRes, mangaRes, manhwaRes] = await Promise.allSettled([
    fetchAiring(range.start, range.end),
    fetchMangaByCountry("JP"),
    fetchMangaByCountry("KR"),
  ]);

  const data: Record<Tab, AiringEntry[] | MangaEntry[]> = {
    anime:  animeRes.status  === "fulfilled" ? animeRes.value  : [],
    manga:  mangaRes.status  === "fulfilled" ? mangaRes.value  : [],
    manhwa: manhwaRes.status === "fulfilled" ? manhwaRes.value : [],
  };

  // Estado do coletor
  let currentTab: Tab = "anime";
  const pages: Record<Tab, number> = { anime: 0, manga: 0, manhwa: 0 };

  function buildEmbed(tab: Tab, page: number): EmbedBuilder {
    if (tab === "anime") return buildAnimeEmbed(data.anime as AiringEntry[], titulo, emoji, page);
    return buildComicEmbed(data[tab] as MangaEntry[], tab, page);
  }

  function buildSubscribeRow(
    tab: Tab,
    page: number,
    disabled = false,
  ): ActionRowBuilder<StringSelectMenuBuilder> | null {
    const entries = data[tab];
    const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    if (!slice.length) return null;

    const options = (slice as (AiringEntry | MangaEntry)[]).slice(0, 25).map((e) => {
      if ("airingAt" in e) {
        const ae = e as AiringEntry;
        return { label: (ae.media.title.english ?? ae.media.title.romaji).slice(0, 100) || "?", value: `anilist-anime:${ae.media.id}` };
      }
      const me = e as MangaEntry;
      return { label: (me.title.english ?? me.title.romaji).slice(0, 100) || "?", value: `anilist:${me.id}` };
    });

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("cal_subscribe")
        .setPlaceholder("🔔 Assinar um título desta página...")
        .addOptions(options)
        .setDisabled(disabled),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildComponents(tab: Tab, page: number, disabled = false): ActionRowBuilder<any>[] {
    const tabRow = buildTabRow(tab, disabled);
    const navRow = buildNavRow(page, data[tab].length, "cal", disabled);
    const subRow = buildSubscribeRow(tab, page, disabled);
    return [tabRow, ...(navRow ? [navRow] : []), ...(subRow ? [subRow] : [])];
  }

  try {
    const msg = await interaction.editReply({
      embeds: [buildEmbed("anime", 0)],
      components: buildComponents("anime", 0),
    });

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15 * 60 * 1000,
    });

    collector.on("collect", async (btn) => {
      try {
        const id = btn.customId;

        if (id === "cal_prev") {
          pages[currentTab] = Math.max(0, pages[currentTab] - 1);
        } else if (id === "cal_next") {
          const maxPage = Math.ceil(data[currentTab].length / PAGE_SIZE) - 1;
          pages[currentTab] = Math.min(maxPage, pages[currentTab] + 1);
        } else if (id.startsWith("cal_") && !id.includes("_prev") && !id.includes("_next") && !id.includes("_page")) {
          const next = id.replace("cal_", "") as Tab;
          if (next !== currentTab) {
            currentTab = next;
            pages[currentTab] = 0; // reset ao trocar de aba
          }
        } else {
          return; // indicador de página — sem ação
        }

        // Atualiza e confirma o clique em uma única resposta ao Discord.
        await btn.update({
          embeds: [buildEmbed(currentTab, pages[currentTab])],
          components: buildComponents(currentTab, pages[currentTab]),
        });
      } catch (err) {
        logger.error({ err, customId: btn.customId }, "Erro ao processar botão do calendario");
        if (!btn.replied && !btn.deferred) {
          await btn.reply({
            content: "❌ Não foi possível trocar a página. Tente executar `/calendario` novamente.",
            ephemeral: true,
          }).catch(() => {});
        }
      }
    });

    collector.on("end", () => {
      interaction
        .editReply({ components: buildComponents(currentTab, pages[currentTab], true) })
        .catch(() => {});
    });

    // ── Coletor de assinaturas via Select Menu ───────────────────────────────
    const selectCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 15 * 60 * 1000,
    });

    selectCollector.on("collect", async (sel) => {
      if (sel.customId !== "cal_subscribe") return;
      if (!sel.guildId) {
        await sel.reply({ content: "❌ Só pode ser usado em servidores.", ephemeral: true });
        return;
      }
      await sel.deferReply({ ephemeral: true });

      const value   = sel.values[0];
      const colonAt = value.indexOf(":");
      const src     = value.slice(0, colonAt);
      const numId   = parseInt(value.slice(colonAt + 1), 10);

      let title   = "";
      let siteUrl = "";

      if (src === "anilist-anime") {
        const entry = (data.anime as AiringEntry[]).find((e) => e.media.id === numId);
        title   = entry ? (entry.media.title.english ?? entry.media.title.romaji) : "";
        siteUrl = entry?.media.siteUrl ?? `https://anilist.co/anime/${numId}`;
      } else {
        const entry = (data[currentTab] as MangaEntry[]).find((e) => e.id === numId);
        title   = entry ? (entry.title.english ?? entry.title.romaji) : "";
        siteUrl = entry?.siteUrl ?? `https://anilist.co/manga/${numId}`;
      }

      if (!title) {
        await sel.editReply("❌ Não foi possível identificar o título. Tente novamente.");
        return;
      }

      const tipo: "anime" | "manga" | "manhwa" =
        src === "anilist-anime" ? "anime" : (currentTab as "manga" | "manhwa");
      const manhwaId = String(numId);

      const existing = await db
        .select({ id: assinaturasTable.id })
        .from(assinaturasTable)
        .where(and(
          eq(assinaturasTable.discordUserId, sel.user.id),
          eq(assinaturasTable.manhwaId, manhwaId),
          eq(assinaturasTable.guildId, sel.guildId),
        ));

      if (existing.length) {
        await sel.editReply(`⚠️ Você já está assinando **${title}** neste servidor!`);
        return;
      }

      await db.insert(assinaturasTable).values({
        discordUserId: sel.user.id,
        guildId: sel.guildId,
        manhwaId,
        source: src,
        title,
        coverUrl: null,
        siteUrl,
        tipo,
        adult: false,
      });

      await sel.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔔 Assinatura Confirmada!")
            .setColor(0x2ecc71)
            .setDescription(
              `Você será mencionado quando saírem novos conteúdos de:\n\n📖 **[${title}](${siteUrl})**`
            ),
        ],
      });
    });
  } catch {
    await interaction.editReply("❌ Erro ao buscar o calendário. Tente novamente em instantes.");
  }
}
