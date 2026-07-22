/**
 * Comando /manga — busca mangás japoneses no MangaDex.
 * Diferente de /buscar (focado em manhwa coreano), este comando
 * busca especificamente mangás de origem japonesa.
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
import { searchMangaDexJp, getMangaDexById, type MangaDexResult } from "../mangadex.js";
import { translateToPtBr, cleanDescription } from "../anilist.js";

export const data = new SlashCommandBuilder()
  .setName("manga")
  .setDescription("Busca mangás japoneses no MangaDex com sinopse traduzida")
  .addStringOption((opt) =>
    opt
      .setName("titulo")
      .setDescription("Nome do mangá (ex: One Piece, Berserk, Chainsaw Man)")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("genero")
      .setDescription("Filtrar por gênero (opcional)")
      .setRequired(false)
      .addChoices(
        { name: "Ação", value: "391b0423-d847-456f-aff0-8b0cfc03066b" },
        { name: "Aventura", value: "87cc87cd-a395-47af-b27a-93258283bbc6" },
        { name: "Comédia", value: "4d32cc48-9f00-4cca-9b5a-a839f0764984" },
        { name: "Drama", value: "b9af3a63-f058-46de-a9a0-e0c13906197a" },
        { name: "Fantasia", value: "cdc58593-87dd-415e-bbc0-2ec27bf404cc" },
        { name: "Horror", value: "cdad7e68-1419-41dd-bdce-27753074a640" },
        { name: "Romance", value: "423e2eae-a7a2-4a8b-ac03-a8351462d71d" },
        { name: "Slice of Life", value: "e5301a23-ebd9-49dd-a0cb-2add944c7fe9" }
      )
  );

// ─── Cache de autocomplete ────────────────────────────────────────────────────

interface AutocompleteOption { name: string; value: string }
const autocompleteCache = new Map<string, { results: AutocompleteOption[]; ts: number }>();
const CACHE_TTL = 30_000;

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  if (!focused || focused.length < 2) { await interaction.respond([]); return; }

  const cached = autocompleteCache.get(focused);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    await interaction.respond(cached.results);
    return;
  }

  try {
    const results = await searchMangaDexJp(focused, 10);
    const options: AutocompleteOption[] = results.slice(0, 25).map((r) => ({
      name: r.mainTitle.slice(0, 100),
      value: `mangadex:${r.id}`,
    }));
    autocompleteCache.set(focused, { results: options, ts: Date.now() });
    await interaction.respond(options);
  } catch {
    await interaction.respond([]);
  }
}

// ─── Status label ─────────────────────────────────────────────────────────────

function statusLabel(status: string | null): string {
  const map: Record<string, string> = {
    RELEASING: "Em lançamento",
    FINISHED: "Finalizado",
    HIATUS: "Em hiato",
    CANCELLED: "Cancelado",
  };
  return status ? (map[status] ?? status) : "Desconhecido";
}

// ─── Embed ────────────────────────────────────────────────────────────────────

async function buildMangaEmbed(r: MangaDexResult): Promise<EmbedBuilder> {
  const rawDesc = cleanDescription(r.description ?? "");
  const synopsis = rawDesc
    ? await translateToPtBr(rawDesc)
    : "Sem sinopse disponível.";

  const embed = new EmbedBuilder()
    .setTitle(r.mainTitle)
    .setURL(r.siteUrl)
    .setDescription(synopsis)
    .setColor(0xf6821f) // laranja MangaDex
    .addFields(
      {
        name: "Status",
        value: `📌 ${statusLabel(r.status)}`,
        inline: true,
      },
      {
        name: "Capítulos",
        value: r.chapters ? `📖 ${r.chapters}` : "📖 Desconhecido",
        inline: true,
      },
      {
        name: "Ano",
        value: r.year ? String(r.year) : "—",
        inline: true,
      }
    );

  if (r.genres.length > 0) {
    embed.addFields({
      name: "Gêneros",
      value: r.genres.join(" • "),
      inline: false,
    });
  }

  // Títulos alternativos
  const altTitles: string[] = [];
  const seen = new Set<string>([r.mainTitle.toLowerCase()]);
  for (const t of [r.nativeTitle, r.romajiTitle, ...r.synonyms]) {
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      altTitles.push(t);
    }
  }
  if (altTitles.length > 0) {
    embed.addFields({
      name: "Títulos alternativos",
      value: altTitles.slice(0, 5).join("\n"),
      inline: false,
    });
  }

  embed.addFields({
    name: "🔗 Links",
    value: `[Ver no MangaDex](${r.siteUrl})`,
    inline: false,
  });

  if (r.coverUrl) embed.setThumbnail(r.coverUrl);

  embed.setFooter({
    text: "📚 Fonte: MangaDex • Sinopse traduzida automaticamente",
  });

  return embed;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const titulo = interaction.options.getString("titulo", true);
  const generoId = interaction.options.getString("genero");

  await interaction.deferReply();

  // Detecta seleção via autocomplete (formato "mangadex:<id>")
  const autocompleteMatch = /^mangadex:(.+)$/.exec(titulo);

  if (autocompleteMatch) {
    const id = autocompleteMatch[1]!;
    try {
      const manga = await getMangaDexById(id);
      if (!manga) {
        await interaction.editReply("❌ Não foi possível carregar os detalhes. Tente digitar o título manualmente.");
        return;
      }
      const embed = await buildMangaEmbed(manga);
      await interaction.editReply({ content: null, embeds: [embed] });
    } catch {
      await interaction.editReply("❌ Erro ao buscar detalhes. Tente novamente.");
    }
    return;
  }

  try {
    const results = await searchMangaDexJp(titulo, 8, generoId ?? undefined);

    if (!results.length) {
      await interaction.editReply(
        `❌ Nenhum mangá encontrado para **${titulo}**.\n` +
          "💡 Tente usar o título em inglês ou japonês (romaji)."
      );
      return;
    }

    if (results.length === 1) {
      const embed = await buildMangaEmbed(results[0]!);
      await interaction.editReply({ content: null, embeds: [embed] });
      return;
    }

    const options = results.slice(0, 8).map((r) => ({
      label: r.mainTitle.slice(0, 100),
      description: [
        statusLabel(r.status),
        r.chapters ? `${r.chapters} caps` : "",
        r.year ? String(r.year) : "",
        r.genres[0] ?? "",
      ]
        .filter(Boolean)
        .join(" • ")
        .slice(0, 100),
      value: r.id,
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("manga_select")
        .setPlaceholder("Selecione o mangá correto")
        .addOptions(options)
    );

    await interaction.editReply({
      content: `📚 Encontrei **${results.length}** mangás para **${titulo}**. Selecione:`,
      components: [row],
    });

    const collector = interaction.channel?.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) =>
        i.customId === "manga_select" && i.user.id === interaction.user.id,
      time: 30_000,
      max: 1,
    });

    collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
      await sel.deferUpdate();
      try {
        const manga = await getMangaDexById(sel.values[0]!);
        if (!manga) {
          await interaction.editReply({ content: "❌ Erro ao carregar detalhes.", components: [] });
          return;
        }
        const embed = await buildMangaEmbed(manga);
        await interaction.editReply({ content: null, embeds: [embed], components: [] });
      } catch {
        await interaction.editReply({ content: "❌ Erro inesperado. Tente novamente.", components: [] });
      }
    });

    collector?.on("end", async (_c, reason) => {
      if (reason === "time") {
        await interaction.editReply({ content: "⏱️ Tempo esgotado. Use `/manga` novamente.", components: [] });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await interaction.editReply(`❌ Erro ao buscar mangá: ${msg}`);
  }
}
