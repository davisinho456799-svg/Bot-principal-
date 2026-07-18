/**
 * Comando /vn — pesquisa visual novels no VNDB.
 * Mostra: título, sinopse, score, duração, tags, desenvolvedores, idiomas disponíveis.
 */

import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { searchVNDB, getVNDBById, type VNDBResult } from "../vndb.js";
import { translateToPtBr } from "../anilist.js";

export const data = new SlashCommandBuilder()
  .setName("vn")
  .setDescription("Pesquisa uma visual novel no VNDB — sinopse, tags, duração estimada e onde jogar")
  .addStringOption((opt) =>
    opt
      .setName("titulo")
      .setDescription("Nome da visual novel para pesquisar")
      .setRequired(true)
      .setAutocomplete(true)
  );

// ─── Autocomplete ─────────────────────────────────────────────────────────────

const autocompleteCache = new Map<string, { results: string[]; ts: number }>();
const CACHE_TTL = 30_000;

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  if (!focused || focused.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cached = autocompleteCache.get(focused);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    await interaction.respond(cached.results.map((t) => ({ name: t.slice(0, 100), value: t.slice(0, 100) })));
    return;
  }

  try {
    const results = await searchVNDB(focused);
    const titles = results.map((r) => r.mainTitle);
    autocompleteCache.set(focused, { results: titles, ts: Date.now() });
    await interaction.respond(titles.slice(0, 25).map((t) => ({ name: t.slice(0, 100), value: t.slice(0, 100) })));
  } catch {
    await interaction.respond([]);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LANG_FLAGS: Record<string, string> = {
  EN: "🇬🇧", JA: "🇯🇵", ZH: "🇨🇳", PT: "🇧🇷", KO: "🇰🇷", DE: "🇩🇪",
  FR: "🇫🇷", ES: "🇪🇸", RU: "🇷🇺", IT: "🇮🇹", PL: "🇵🇱", VI: "🇻🇳",
  TL: "🇵🇭", TH: "🇹🇭", NL: "🇳🇱", TR: "🇹🇷", CS: "🇨🇿", UK: "🇺🇦",
  HU: "🇭🇺", RO: "🇷🇴",
};

function langFlags(langs: string[]): string {
  if (langs.length === 0) return "—";
  return langs
    .slice(0, 10)
    .map((l) => `${LANG_FLAGS[l] ?? "🌐"} ${l}`)
    .join(" ");
}

function buildAltTitles(r: VNDBResult): string | null {
  const seen = new Set<string>([r.mainTitle.toLowerCase()]);
  const titles: string[] = [];
  if (r.altTitle && !seen.has(r.altTitle.toLowerCase())) { seen.add(r.altTitle.toLowerCase()); titles.push(r.altTitle); }
  for (const s of r.synonyms) {
    if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); titles.push(s); }
  }
  return titles.length ? titles.slice(0, 5).join("\n") : null;
}

function scoreStars(score: number | null): string {
  if (!score) return "⭐ N/A";
  const s = score / 10; // VNDB 10–90 → 1–9 scale
  return `⭐ ${s.toFixed(1)}/10 (${score}%)`;
}

// ─── Embed ────────────────────────────────────────────────────────────────────

async function buildVNEmbed(r: VNDBResult): Promise<EmbedBuilder> {
  const rawDesc = r.description ?? "";
  // VNDB descriptions use BBCode-ish tags — strip them
  const cleanDesc = rawDesc
    .replace(/\[url=[^\]]+\]([^\[]*)\[\/url\]/g, "$1")
    .replace(/\[[^\]]+\]/g, "")
    .trim();
  const synopsis = cleanDesc ? await translateToPtBr(cleanDesc) : "Sem sinopse disponível.";

  const released = r.released
    ? r.released.length === 4
      ? r.released
      : new Date(r.released).toLocaleDateString("pt-BR", { year: "numeric", month: "long", day: "numeric" })
    : "—";

  const embed = new EmbedBuilder()
    .setTitle(r.mainTitle)
    .setURL(r.siteUrl)
    .setDescription(synopsis.slice(0, 4000))
    .setColor(0x337ab7)
    .addFields(
      { name: "⭐ Avaliação", value: scoreStars(r.score), inline: true },
      { name: "📊 Votos", value: r.votecount.toLocaleString("pt-BR"), inline: true },
      { name: "📅 Lançamento", value: released, inline: true },
    );

  if (r.length) {
    embed.addFields({ name: "⏱️ Duração estimada", value: r.length, inline: true });
  }

  if (r.developers.length > 0) {
    embed.addFields({ name: "🏢 Desenvolvedora(s)", value: r.developers.slice(0, 3).join(", "), inline: true });
  }

  embed.addFields({
    name: "🌐 Idiomas disponíveis",
    value: langFlags(r.languages),
    inline: false,
  });

  if (r.tags.length > 0) {
    embed.addFields({ name: "🏷️ Tags", value: r.tags.slice(0, 10).join(" • "), inline: false });
  }

  if (r.coverUrl) embed.setThumbnail(r.coverUrl);

  const altTitles = buildAltTitles(r);
  if (altTitles) embed.addFields({ name: "Títulos alternativos", value: altTitles, inline: false });

  if (r.isAdult) {
    embed.addFields({ name: "⚠️ Conteúdo adulto", value: "Esta VN contém conteúdo explícito.", inline: false });
  }

  // Onde jogar / comprar
  const encoded = encodeURIComponent(r.mainTitle);
  const platforms = [
    `[VNDB](${r.siteUrl})`,
    `[Steam](https://store.steampowered.com/search/?term=${encoded})`,
    `[Johren](https://www.johren.net/games/search/?keyword=${encoded})`,
    `[Denpasoft](https://denpasoft.com/?s=${encoded})`,
    `[MangaGamer](https://www.mangagamer.com/search.php?search_query=${encoded})`,
  ].join(" • ");
  embed.addFields({ name: "🕹️ Onde jogar", value: platforms, inline: false });

  embed.setFooter({ text: "🔵 VNDB • Sinopse traduzida automaticamente" });

  return embed;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const titulo = interaction.options.getString("titulo", true);

  await interaction.deferReply();

  let results: VNDBResult[];
  try {
    results = await searchVNDB(titulo);
  } catch {
    await interaction.editReply("❌ Erro ao consultar o VNDB. Tente novamente.");
    return;
  }

  if (!results.length) {
    await interaction.editReply(
      `❌ Nenhuma visual novel encontrada para **${titulo}**.\nTente usar parte do título ou o título em japonês/inglês.`
    );
    return;
  }

  if (results.length === 1) {
    const embed = await buildVNEmbed(results[0]);
    await interaction.editReply({ content: null, embeds: [embed] });
    return;
  }

  const options = results.slice(0, 8).map((r) => ({
    label: r.mainTitle.slice(0, 100),
    description: [
      `🔵 VNDB`,
      r.length ?? null,
      r.developers[0] ?? null,
      r.year ? String(r.year) : null,
    ]
      .filter(Boolean)
      .join(" • ")
      .slice(0, 100),
    value: r.vnId,
  }));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vn_select")
      .setPlaceholder("Selecione a visual novel correta")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `🔍 Encontrei **${results.length}** resultados no VNDB. Selecione:`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "vn_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (selectInteraction: StringSelectMenuInteraction) => {
    await selectInteraction.deferUpdate();
    try {
      const vnId = selectInteraction.values[0]!;
      const vn = await getVNDBById(vnId);
      if (!vn) {
        await interaction.editReply({ content: "❌ Não foi possível carregar os detalhes. Tente outro resultado.", components: [] });
        return;
      }
      const embed = await buildVNEmbed(vn);
      await interaction.editReply({ content: null, embeds: [embed], components: [] });
    } catch {
      await interaction.editReply({ content: "❌ Erro inesperado. Tente novamente.", components: [] });
    }
  });

  collector?.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await interaction.editReply({ content: "⏱️ Tempo esgotado. Use `/vn` novamente.", components: [] });
    }
  });
}
