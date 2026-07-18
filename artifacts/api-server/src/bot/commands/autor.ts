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
  id: number;
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
  id: number;
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
  if (!res.ok) throw new Error(`AniList error: ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
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

  let staffList: StaffBasic[];
  try {
    const data = await anilistFetch<{ Page: { staff: StaffBasic[] } }>(SEARCH_STAFF_QUERY, { search: nome });
    staffList = data.Page.staff ?? [];
  } catch {
    await interaction.editReply("❌ Erro ao buscar o autor. Tente novamente.");
    return;
  }

  if (!staffList.length) {
    await interaction.editReply(`❌ Nenhum autor encontrado com o nome **${nome}**.`);
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
    const data = await anilistFetch<{ Staff: StaffFull }>(STAFF_WORKS_QUERY, { id: chosenStaff.id, page: 1 });
    staffFull = data.Staff;
  } catch {
    await interaction.editReply("❌ Erro ao buscar as obras do autor. Tente novamente.");
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
      text: `${worksToShow.length} obra(s) listada(s) • Fonte: AniList`,
    });

  if (staffFull.image.large) embed.setThumbnail(staffFull.image.large);

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
