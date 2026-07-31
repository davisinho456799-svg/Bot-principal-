/**
 * Comando /calendario18 — calendário de conteúdo adulto (+18) em lançamento.
 * Fontes: AniList (anime, manga JP, manhwa KR), VNDB (visual novels).
 * Botões para alternar abas e paginar resultados (20 por página).
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
import { fetchVNDBAdultCalendar, type VNDBResult } from "../vndb.js";
import { db, assinaturasTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getUnifiedById } from "../unified.js";

const ANILIST_API = "https://graphql.anilist.co";
const PAGE_SIZE   = 20;

// ─── Queries AniList ──────────────────────────────────────────────────────────

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

const ADULT_COMIC_QUERY = `
query AdultComic($page: Int, $country: CountryCode) {
  Page(page: $page, perPage: 25) {
    media(
      type: MANGA
      status: RELEASING
      isAdult: true
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

interface AdultComic {
  id: number;
  title: { romaji: string; english: string | null };
  genres: string[];
  averageScore: number | null;
  siteUrl: string;
  coverImage: { color: string | null };
  updatedAt: number;
}

// ─── Filtros de data ──────────────────────────────────────────────────────────

function nowTs(): number { return Math.floor(Date.now() / 1000); }

function endOfDay(offsetDays = 0): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1000);
}

function endOfWeek():  number { return nowTs() + 7 * 86_400; }

function endOfMonth(): number {
  const d = new Date();
  return Math.floor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)).getTime() / 1000);
}

function formatAiringDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatUpdatedDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// ─── Busca ────────────────────────────────────────────────────────────────────

async function fetchAdultAiring(): Promise<AdultMedia[]> {
  const pages = await Promise.allSettled(
    [1, 2, 3].map((page) =>
      fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ADULT_AIRING_QUERY, variables: { page } }),
        signal: AbortSignal.timeout(12000),
      }).then(async (r) => {
        if (!r.ok) return [];
        const j = (await r.json()) as {
          data: { Page: { media: AdultMedia[]; pageInfo: { hasNextPage: boolean } } };
          errors?: unknown[];
        };
        return j.errors?.length ? [] : (j.data.Page.media ?? []);
      }),
    ),
  );
  return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
}

async function fetchAdultComic(country: "JP" | "KR"): Promise<AdultComic[]> {
  const pages = await Promise.allSettled(
    [1, 2, 3].map((page) =>
      fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ADULT_COMIC_QUERY, variables: { page, country } }),
        signal: AbortSignal.timeout(12000),
      }).then(async (r) => {
        if (!r.ok) return [];
        const j = (await r.json()) as { data: { Page: { media: AdultComic[] } }; errors?: unknown[] };
        return j.errors?.length ? [] : (j.data.Page.media ?? []);
      }),
    ),
  );
  return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
}

// ─── Builders de embed ────────────────────────────────────────────────────────

function buildAnimeEmbed(filtered: AdultMedia[], periodoLabel: string, page: number): EmbedBuilder {
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const slice      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const color      = slice[0]?.coverImage.color
    ? parseInt(slice[0].coverImage.color.replace("#", ""), 16)
    : 0xc0392b;
  const offset = page * PAGE_SIZE;

  const lines = slice.map((m, i) => {
    const title  = m.title.english ?? m.title.romaji;
    const score  = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const genres = m.genres.slice(0, 2).join(", ") || "—";
    const studio = m.studios.nodes[0]?.name ?? "—";
    const airingLine = m.nextAiringEpisode
      ? `📡 Ep ${m.nextAiringEpisode.episode} — ${formatAiringDate(m.nextAiringEpisode.airingAt)}`
      : `📡 Sem ep agendado${m.startDate.year ? ` (${m.startDate.year})` : ""}`;
    return (
      `**${offset + i + 1}.** [${title}](${m.siteUrl}) — ${score}\n` +
      `> ${airingLine}\n> 🏢 ${studio} • 🏷️ ${genres}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`🔞 Calendário +18 — Anime (${periodoLabel})`)
    .setDescription(
      `⚠️ Títulos marcados como adultos pelo **AniList**.\n\n` +
      (lines.length ? lines.join("\n\n").slice(0, 3500) : "_Nenhum anime +18 encontrado para esse período._"),
    )
    .setColor(color)
    .setFooter({ text: `Página ${page + 1}/${totalPages} • ${filtered.length} título(s) • Horários de Brasília • Fonte: AniList` });
}

function buildComicEmbed18(entries: AdultComic[], type: "manga" | "manhwa", page: number): EmbedBuilder {
  const isManhwa   = type === "manhwa";
  const totalPages = Math.ceil(entries.length / PAGE_SIZE) || 1;
  const slice      = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const color      = slice[0]?.coverImage.color
    ? parseInt(slice[0].coverImage.color.replace("#", ""), 16)
    : isManhwa ? 0xe67e22 : 0xe74c3c;
  const flag   = isManhwa ? "🇰🇷" : "🇯🇵";
  const label  = isManhwa ? "Manhwa" : "Manga";
  const offset = page * PAGE_SIZE;

  const lines = slice.map((m, i) => {
    const title  = m.title.english ?? m.title.romaji;
    const score  = m.averageScore ? ` ⭐${(m.averageScore / 10).toFixed(1)}` : "";
    const genres = m.genres.slice(0, 2).join(", ");
    return (
      `**${offset + i + 1}.** [${title}](${m.siteUrl})${score}\n` +
      `> ${flag} ${label} | 🗓️ Atualizado: ${formatUpdatedDate(m.updatedAt)} | 🏷️ ${genres || "—"}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`🔞 Calendário +18 — ${flag} ${label}`)
    .setDescription(
      `⚠️ Títulos marcados como adultos pelo **AniList**.\n\n` +
      (lines.length ? lines.join("\n\n").slice(0, 3500) : `_Nenhum ${label.toLowerCase()} +18 encontrado._`),
    )
    .setColor(color)
    .setFooter({ text: `Página ${page + 1}/${totalPages} • ${entries.length} série(s) em lançamento • Fonte: AniList` });
}

function buildVNDBEmbed(vns: VNDBResult[], page: number): EmbedBuilder {
  const totalPages = Math.ceil(vns.length / PAGE_SIZE) || 1;
  const slice      = vns.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const offset     = page * PAGE_SIZE;

  const lines = slice.map((vn, i) => {
    const score  = vn.score         ? `⭐ ${vn.score}/100` : "⭐ N/A";
    const length = vn.length        ? `⏱️ ${vn.length}` : "";
    const dev    = vn.developers[0] ?? "—";
    const rel    = vn.released      ?? "Data desconhecida";
    const tags   = vn.tags.slice(0, 3).join(", ") || "—";
    const langs  = vn.languages.length ? `🌐 ${vn.languages.slice(0, 4).join(" ")}` : "";
    return (
      `**${offset + i + 1}.** [${vn.mainTitle}](${vn.siteUrl}) — ${score}\n` +
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
    .setFooter({ text: `Página ${page + 1}/${totalPages} • ${vns.length} título(s) • Fonte: VNDB` });
}

// ─── Botões de aba e navegação ────────────────────────────────────────────────

type Tab = "anime" | "manga" | "manhwa" | "vn";

const TAB_DEFS: { id: Tab; label: string }[] = [
  { id: "anime",  label: "🎬 Anime"        },
  { id: "manga",  label: "🇯🇵 Manga"       },
  { id: "manhwa", label: "🇰🇷 Manhwa"      },
  { id: "vn",     label: "📖 Visual Novel" },
];

function buildTabRow(active: Tab, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    TAB_DEFS.map((t) =>
      new ButtonBuilder()
        .setCustomId(`cal18_${t.id}`)
        .setLabel(t.label)
        .setStyle(t.id === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );
}

function buildNavRow(page: number, total: number, disabled = false): ActionRowBuilder<ButtonBuilder> | null {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return null;

  const btns: ButtonBuilder[] = [];

  if (page > 0) {
    btns.push(
      new ButtonBuilder()
        .setCustomId("cal18_prev")
        .setLabel("⬅️ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }

  btns.push(
    new ButtonBuilder()
      .setCustomId("cal18_page_indicator")
      .setLabel(`Página ${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  if (page < totalPages - 1) {
    btns.push(
      new ButtonBuilder()
        .setCustomId("cal18_next")
        .setLabel("Próxima ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(btns);
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("calendario18")
  .setDescription("⚠️ +18 — Calendário de anime, manga (JP), manhwa (KR) e visual novels adultos")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Filtrar animes por período do próximo episódio (aba Anime)")
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
      .setName("aba")
      .setDescription("Aba inicial ao abrir o calendário (padrão: Anime)")
      .setRequired(false)
      .addChoices(
        { name: "🎬 Anime",          value: "anime"  },
        { name: "🇯🇵 Manga",         value: "manga"  },
        { name: "🇰🇷 Manhwa",        value: "manhwa" },
        { name: "📖 Visual Novel",   value: "vn"     },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo    = interaction.options.getString("periodo") ?? "todos";
  const abaInicial = (interaction.options.getString("aba") ?? "anime") as Tab;

  await interaction.deferReply();

  // ── Busca todas as fontes em paralelo ────────────────────────────────────────
  const [animeResult, mangaResult, manhwaResult, vnResult] = await Promise.allSettled([
    fetchAdultAiring(),
    fetchAdultComic("JP"),
    fetchAdultComic("KR"),
    fetchVNDBAdultCalendar(2, 1),
  ]);

  // ── Filtra anime por período ──────────────────────────────────────────────────
  let animeList: AdultMedia[] = animeResult.status === "fulfilled" ? animeResult.value : [];

  const now = nowTs();
  let deadline: number | null = null;
  let periodoLabel = "Em Lançamento";

  switch (periodo) {
    case "hoje":   deadline = endOfDay(0);  periodoLabel = "Hoje";        break;
    case "amanha": deadline = endOfDay(1);  periodoLabel = "Amanhã";      break;
    case "semana": deadline = endOfWeek();  periodoLabel = "Esta Semana"; break;
    case "mes":    deadline = endOfMonth(); periodoLabel = "Este Mês";    break;
  }

  if (deadline !== null) {
    animeList = animeList.filter(
      (m) => m.nextAiringEpisode &&
             m.nextAiringEpisode.airingAt >= now &&
             m.nextAiringEpisode.airingAt <= deadline!,
    );
  }
  animeList.sort((a, b) =>
    (a.nextAiringEpisode?.airingAt ?? Infinity) - (b.nextAiringEpisode?.airingAt ?? Infinity),
  );

  // ── Dados por aba ─────────────────────────────────────────────────────────────
  const tabData = {
    anime:  animeList,
    manga:  mangaResult.status  === "fulfilled" ? mangaResult.value  : [] as AdultComic[],
    manhwa: manhwaResult.status === "fulfilled" ? manhwaResult.value : [] as AdultComic[],
    vn:     vnResult.status     === "fulfilled" ? vnResult.value as VNDBResult[] : [] as VNDBResult[],
  };

  // Estado do coletor
  let currentTab: Tab = abaInicial;
  const pages: Record<Tab, number> = { anime: 0, manga: 0, manhwa: 0, vn: 0 };

  function buildEmbed(tab: Tab, page: number): EmbedBuilder {
    if (tab === "anime")  return buildAnimeEmbed(tabData.anime, periodoLabel, page);
    if (tab === "manga")  return buildComicEmbed18(tabData.manga, "manga", page);
    if (tab === "manhwa") return buildComicEmbed18(tabData.manhwa, "manhwa", page);
    return buildVNDBEmbed(tabData.vn, page);
  }

  function buildSubscribeRow(
    tab: Tab,
    page: number,
    disabled = false,
  ): ActionRowBuilder<StringSelectMenuBuilder> | null {
    // Visual Novels não têm IDs do AniList — pula
    if (tab === "vn") return null;

    const entries = tabData[tab] as (AdultMedia | AdultComic)[];
    const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    if (!slice.length) return null;

    const options = slice.slice(0, 25).map((e) => {
      const title = ((e.title.english ?? e.title.romaji) || "?").slice(0, 100);
      const value = tab === "anime" ? `anilist-anime:${e.id}` : `anilist:${e.id}`;
      return { label: title, value };
    });

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("cal18_subscribe")
        .setPlaceholder("🔔 Assinar um título desta página...")
        .addOptions(options)
        .setDisabled(disabled),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildComponents(tab: Tab, page: number, disabled = false): ActionRowBuilder<any>[] {
    const tabRow = buildTabRow(tab, disabled);
    const navRow = buildNavRow(page, tabData[tab].length, disabled);
    const subRow = buildSubscribeRow(tab, page, disabled);
    return [tabRow, ...(navRow ? [navRow] : []), ...(subRow ? [subRow] : [])];
  }

  try {
    const msg = await interaction.editReply({
      embeds: [buildEmbed(abaInicial, 0)],
      components: buildComponents(abaInicial, 0),
    });

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15 * 60 * 1000,
    });

    collector.on("collect", async (btn) => {
      await btn.deferUpdate();
      const id = btn.customId;

      if (id === "cal18_prev") {
        pages[currentTab] = Math.max(0, pages[currentTab] - 1);
      } else if (id === "cal18_next") {
        const maxPage = Math.ceil(tabData[currentTab].length / PAGE_SIZE) - 1;
        pages[currentTab] = Math.min(maxPage, pages[currentTab] + 1);
      } else if (id.startsWith("cal18_") && !["cal18_prev", "cal18_next", "cal18_page_indicator"].includes(id)) {
        const next = id.replace("cal18_", "") as Tab;
        if (next !== currentTab) {
          currentTab = next;
          pages[currentTab] = 0; // reset ao trocar de aba
        }
      } else {
        return; // indicador de página — sem ação
      }

      await btn.editReply({
        embeds: [buildEmbed(currentTab, pages[currentTab])],
        components: buildComponents(currentTab, pages[currentTab]),
      });
    });

    collector.on("end", () => {
      interaction
        .editReply({ components: buildComponents(currentTab, pages[currentTab], true) })
        .catch(() => {});
    });

    // ── Coletor de assinaturas via Select Menu (+18) ─────────────────────────
    const selectCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 15 * 60 * 1000,
    });

    selectCollector.on("collect", async (sel) => {
      if (sel.customId !== "cal18_subscribe") return;
      if (!sel.guildId) {
        await sel.reply({ content: "❌ Só pode ser usado em servidores.", ephemeral: true });
        return;
      }
      await sel.deferReply({ ephemeral: true });

      const value   = sel.values[0];
      const colonAt = value.indexOf(":");
      const src     = value.slice(0, colonAt);
      const numId   = parseInt(value.slice(colonAt + 1), 10);

      const entries = tabData[currentTab] as (AdultMedia | AdultComic)[];
      const entry   = entries.find((e) => e.id === numId);

      if (!entry) {
        await sel.editReply("❌ Não foi possível identificar o título. Tente novamente.");
        return;
      }

      const title   = (entry.title.english ?? entry.title.romaji) || "";
      const siteUrl = entry.siteUrl ?? (src === "anilist-anime"
        ? `https://anilist.co/anime/${numId}`
        : `https://anilist.co/manga/${numId}`);

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
        adult: true,
      });

      await sel.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔔 Assinatura +18 Confirmada!")
            .setColor(0xe74c3c)
            .setDescription(
              `Você será mencionado quando saírem novos conteúdos de:\n\n🔞 **[${title}](${siteUrl})**`
            ),
        ],
      });
    });
  } catch {
    await interaction.editReply("❌ Erro ao buscar o calendário. Tente novamente em instantes.");
  }
}
