import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { statusLabel } from "../anilist.js";
import { buildScanLinksExternal } from "./search.js";

const ANILIST_API = "https://graphql.anilist.co";
const MANGADEX_API = "https://api.mangadex.org";

const SEARCH_STAFF_QUERY = `
query SearchStaff($search: String!) {
  Page(page: 1, perPage: 6) {
    staff(search: $search) {
      id
      name { full native }
      image { medium }
      description
      siteUrl
    }
  }
}
`;

const STAFF_WORKS_QUERY = `
query StaffWorks($id: Int!, $page: Int!) {
  Staff(id: $id) {
    id
    name { full native }
    image { large }
    description
    siteUrl
    staffMedia(type: MANGA, page: $page, perPage: 25, sort: START_DATE_DESC) {
      pageInfo { hasNextPage }
      edges {
        staffRole
        node {
          id
          title { romaji english }
          countryOfOrigin
          averageScore
          genres
          chapters
          status
          siteUrl
          startDate { year }
          coverImage { color }
        }
      }
    }
  }
}
`;

interface StaffBasic {
  id: number | string;
  name: { full: string; native: string | null };
  image: { medium: string | null };
  description: string | null;
  siteUrl: string;
}

interface MediaNode {
  id: number;
  title: { romaji: string; english: string | null };
  countryOfOrigin: string | null;
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null };
  coverImage: { color: string | null };
}

interface StaffEdge {
  staffRole: string;
  node: MediaNode;
}

interface StaffFull {
  id: number | string;
  name: { full: string; native: string | null };
  description: string | null;
  siteUrl: string;
  image: { large: string | null };
  staffMedia: {
    pageInfo: { hasNextPage: boolean };
    edges: StaffEdge[];
  };
}

async function anilistFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  const apiMessage = json.errors?.[0]?.message;
  if (!res.ok) {
    throw new Error(`AniList error: ${res.status}${apiMessage ? ": " + apiMessage : ""}`);
  }
  if (apiMessage) throw new Error(apiMessage);
  return json.data as T;
}


type AuthorSource = "anilist" | "mangadex";

interface MangaDexAuthor {
  id: string;
  attributes: {
    name: string;
    biography?: Record<string, string> | null;
    imageUrl?: string | null;
  };
}

interface MangaDexManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    description?: Record<string, string>;
    originalLanguage?: string | null;
    lastChapter?: string | null;
    status?: string | null;
    year?: number | null;
    tags?: Array<{ attributes?: { group?: string; name?: Record<string, string> } }>;
  };
  relationships?: Array<{ type: string; id: string; attributes?: { fileName?: string } }>;
}

interface MangaDexCollection<T> {
  data: T[];
  total?: number;
}

async function mangaDexFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MANGADEX_API}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`MangaDex error: ${res.status}`);
  return json;
}

function mangaDexText(values: Record<string, string> | null | undefined): string | null {
  if (!values) return null;
  return values["pt-br"] ?? values.en ?? values.ko ?? Object.values(values)[0] ?? null;
}

function mangaDexTitle(title: Record<string, string>): string {
  return mangaDexText(title) ?? "Título desconhecido";
}

function mangaDexStatus(status: string | null | undefined): string | null {
  const map: Record<string, string> = { ongoing: "RELEASING", completed: "FINISHED", hiatus: "HIATUS", cancelled: "CANCELLED" };
  return status ? (map[status] ?? status) : null;
}

async function searchMangaDexAuthors(search: string): Promise<StaffBasic[]> {
  const params = new URLSearchParams({ name: search, limit: "6" });
  const result = await mangaDexFetch<MangaDexCollection<MangaDexAuthor>>(`/author?${params.toString()}`);
  return (result.data ?? []).map((author) => ({
    id: author.id,
    name: { full: author.attributes.name, native: null },
    image: { medium: author.attributes.imageUrl ?? null },
    description: mangaDexText(author.attributes.biography),
    siteUrl: `https://mangadex.org/author/${author.id}`,
  }));
}

async function getMangaDexWorks(author: StaffBasic): Promise<StaffFull> {
  const params = new URLSearchParams({ limit: "12", "order[updatedAt]": "desc" });
  params.append("authors[]", String(author.id));
  params.append("includes[]", "cover_art");
  const result = await mangaDexFetch<MangaDexCollection<MangaDexManga>>(`/manga?${params.toString()}`);
  const edges: StaffEdge[] = (result.data ?? []).map((manga) => {
    const attributes = manga.attributes;
    const chapters = Number.parseInt(attributes.lastChapter ?? "", 10);
    const country = attributes.originalLanguage === "ko" ? "KR" : attributes.originalLanguage === "ja" ? "JP" : attributes.originalLanguage === "zh" ? "CN" : null;
    const genres = (attributes.tags ?? [])
      .filter((tag) => tag.attributes?.group === "genre")
      .map((tag) => mangaDexText(tag.attributes?.name))
      .filter((genre): genre is string => Boolean(genre));
    return {
      staffRole: "Autor",
      node: {
        id: manga.id,
        title: { romaji: mangaDexTitle(attributes.title), english: attributes.title.en ?? null },
        countryOfOrigin: country,
        averageScore: null,
        genres,
        chapters: Number.isFinite(chapters) ? chapters : null,
        status: mangaDexStatus(attributes.status),
        siteUrl: `https://mangadex.org/title/${manga.id}`,
        startDate: { year: attributes.year ?? null },
        coverImage: { color: null },
      },
    };
  });
  return {
    id: author.id,
    name: { full: author.name.full, native: author.name.native },
    description: author.description,
    siteUrl: author.siteUrl,
    image: { large: author.image.medium },
    staffMedia: {
      pageInfo: { hasNextPage: (result.total ?? edges.length) > edges.length },
      edges,
    },
  };
}

function isAniListUnavailable(error: unknown): boolean {
  return error instanceof Error && /AniList error: (403|429|5\d\d)|temporarily disabled|timeout/i.test(error.message);
}

function cleanDesc(raw: string | null, maxLen = 200): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim()
    .slice(0, maxLen);
}

export const data = new SlashCommandBuilder()
  .setName("autor")
  .setDescription("Busca todos os manhwas de um autor ou artista")
  .addStringOption((opt) =>
    opt.setName("nome").setDescription("Nome do autor ou artista").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const nome = interaction.options.getString("nome", true);
  await interaction.deferReply();
  await interaction.editReply({ content: `🔍 Buscando autor **${nome}**...` });

  let staffList: StaffBasic[] = [];
  let source: AuthorSource = "anilist";
  let primaryError: unknown = null;
  try {
    const data = await anilistFetch<{ Page: { staff: StaffBasic[] } }>(SEARCH_STAFF_QUERY, { search: nome });
    staffList = data.Page.staff ?? [];
  } catch (error) {
    primaryError = error;
    console.error("[/autor] AniList indisponível; tentando MangaDex", error);
  }

  if (!staffList.length) {
    try {
      const fallbackStaff = await searchMangaDexAuthors(nome);
      if (fallbackStaff.length) {
        staffList = fallbackStaff;
        source = "mangadex";
      }
    } catch (error) {
      console.error("[/autor] Falha no fallback MangaDex", error);
    }
  }

  if (!staffList.length) {
    await interaction.editReply(
      primaryError && isAniListUnavailable(primaryError)
        ? "⚠️ AniList e MangaDex estão indisponíveis no momento. Tente novamente mais tarde."
        : `❌ Nenhum autor encontrado com o nome **${nome}**.`,
    );
    return;
  }

  let chosenStaff: StaffBasic;

  if (staffList.length === 1) {
    chosenStaff = staffList[0];
  } else {
    const options = staffList.slice(0, 6).map((s) => ({
      label: s.name.full.slice(0, 100),
      description: (s.name.native ?? "Nome nativo desconhecido").slice(0, 100),
      value: String(s.id),
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("autor_select")
        .setPlaceholder("Selecione o autor correto")
        .addOptions(options)
    );

    await interaction.editReply({
      content: `👥 Encontrei **${staffList.length}** autores com esse nome. Selecione o correto:`,
      components: [row],
    });

    const selected = await new Promise<StaffBasic | null>((resolve) => {
      const collector = interaction.channel?.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === "autor_select" && i.user.id === interaction.user.id,
        time: 30_000,
        max: 1,
      });
      collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();
        const found = staffList.find((s) => String(s.id) === sel.values[0]) ?? null;
        resolve(found);
      });
      collector?.on("end", (_c, reason) => {
        if (reason === "time") resolve(null);
      });
    });

    if (!selected) {
      await interaction.editReply({ content: "⏱️ Tempo esgotado. Use `/autor` novamente.", components: [] });
      return;
    }
    chosenStaff = selected;
  }

  await interaction.editReply({ content: `⏳ Buscando obras de **${chosenStaff.name.full}**...`, components: [] });

  let staffFull: StaffFull;
  try {
    if (source === "mangadex") {
      staffFull = await getMangaDexWorks(chosenStaff);
    } else {
      const data = await anilistFetch<{ Staff: StaffFull }>(STAFF_WORKS_QUERY, { id: Number(chosenStaff.id), page: 1 });
      staffFull = data.Staff;
    }
  } catch (error) {
    console.error("[/autor] Falha ao buscar obras", error);
    await interaction.editReply(
      source === "mangadex"
        ? "❌ Não foi possível carregar as obras pelo MangaDex. Tente novamente."
        : "❌ Erro ao buscar as obras do autor. Tente novamente.",
    );
    return;
  }

  const edges = staffFull.staffMedia.edges ?? [];

  const manhwas = edges
    .filter((e) => e.node.countryOfOrigin === "KR" || !e.node.countryOfOrigin)
    .slice(0, 12);

  const allWorks = edges.slice(0, 12);
  const worksToShow = manhwas.length >= 3 ? manhwas : allWorks;

  if (!worksToShow.length) {
    await interaction.editReply(`❌ **${staffFull.name.full}** não tem obras listadas no AniList.`);
    return;
  }

  const authorDesc = cleanDesc(staffFull.description, 180);
  const nativeName = staffFull.name.native ? ` (${staffFull.name.native})` : "";

  const workLines = worksToShow.map((e) => {
    const title = e.node.title.english ?? e.node.title.romaji;
    const score = e.node.averageScore ? `⭐ ${(e.node.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const chapters = e.node.chapters ? `📖 ${e.node.chapters} caps` : "📖 Em andamento";
    const status = statusLabel(e.node.status);
    const year = e.node.startDate?.year ? `(${e.node.startDate.year})` : "";
    const role = e.staffRole ? `*${e.staffRole}*` : "";
    const genres = e.node.genres.slice(0, 2).join(", ") || "—";
    const scanLinks = buildScanLinksExternal(title);
    return (
      `**[${title}](${e.node.siteUrl})** ${year} ${role}\n` +
      `> ${score} | ${chapters} | ${status}\n` +
      `> 🏷️ ${genres}\n` +
      `> 🔎 ${scanLinks}`
    );
  });

  const hasMore = staffFull.staffMedia.pageInfo.hasNextPage && worksToShow.length >= 12;

  const embed = new EmbedBuilder()
    .setTitle(`✍️ ${staffFull.name.full}${nativeName}`)
    .setURL(staffFull.siteUrl)
    .setColor(0xe67e22)
    .setDescription(
      (authorDesc ? `*${authorDesc}...*\n\n` : "") +
        workLines.join("\n\n") +
        (hasMore ? "\n\n*...e mais obras no AniList*" : "")
    )
    .setFooter({
      text: `${worksToShow.length} obra(s) listada(s) • Fonte: ${source === "mangadex" ? "MangaDex" : "AniList"}`,
    });

  if (staffFull.image.large) embed.setThumbnail(staffFull.image.large);

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
