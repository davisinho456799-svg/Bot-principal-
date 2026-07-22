/**
 * Comando /filme — busca animes em formato de filme com infos de dublagem.
 * Fonte: TMDB (The Movie Database)
 * Requer env: TMDB_API_KEY
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
import {
  searchAnimeMovieTMDB,
  getAnimeMovieDetails,
  type TMDBResult,
} from "../tmdb.js";

export const data = new SlashCommandBuilder()
  .setName("filme")
  .setDescription(
    "Busca animes em formato de filme com informações de dublagem e lançamento"
  )
  .addStringOption((opt) =>
    opt
      .setName("titulo")
      .setDescription("Nome do filme anime (ex: Your Name, Spirited Away)")
      .setRequired(true)
  );

function formatRuntime(minutes: number | null): string {
  if (!minutes) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function formatScore(score: number, votes: number): string {
  if (!score) return "Sem avaliação";
  return `⭐ ${score.toFixed(1)}/10 (${votes.toLocaleString("pt-BR")} votos)`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const [year, month, day] = dateStr.split("-");
  if (!year) return dateStr;
  const months = [
    "jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez",
  ];
  const m = months[(parseInt(month ?? "1", 10) - 1)] ?? "";
  return `${day} ${m}. ${year}`;
}

async function buildFilmeEmbed(r: TMDBResult): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setURL(r.tmdbUrl)
    .setDescription(r.overview)
    .setColor(0x01b4e4) // azul TMDB
    .addFields(
      {
        name: "Avaliação",
        value: formatScore(r.score, r.voteCount),
        inline: true,
      },
      {
        name: "Lançamento",
        value: formatDate(r.releaseDate),
        inline: true,
      },
      {
        name: "Duração",
        value: formatRuntime(r.runtime),
        inline: true,
      }
    );

  if (r.originalTitle && r.originalTitle !== r.title) {
    embed.addFields({
      name: "Título original",
      value: r.originalTitle,
      inline: true,
    });
  }

  if (r.genres.length > 0) {
    embed.addFields({
      name: "Gêneros",
      value: r.genres.join(" • "),
      inline: false,
    });
  }

  if (r.productionStudios.length > 0) {
    embed.addFields({
      name: "Estúdio(s)",
      value: r.productionStudios.join(", "),
      inline: true,
    });
  }

  // Informações de dublagem PT-BR
  const dubStatus = r.isDubbed
    ? "✅ Possui tradução/dublagem em PT-BR"
    : "❌ Sem dublagem PT-BR registrada";
  embed.addFields({
    name: "🇧🇷 Dublagem",
    value: dubStatus,
    inline: false,
  });

  if (r.languages.length > 0) {
    embed.addFields({
      name: "Idiomas disponíveis",
      value: r.languages.slice(0, 8).join(", "),
      inline: false,
    });
  }

  // Links externos
  const links: string[] = [`[TMDB](${r.tmdbUrl})`];
  if (r.imdbUrl) links.push(`[IMDb](${r.imdbUrl})`);
  embed.addFields({
    name: "🔗 Links",
    value: links.join(" • "),
    inline: false,
  });

  if (r.posterUrl) embed.setThumbnail(r.posterUrl);

  embed.setFooter({
    text: "🎬 Fonte: TMDB • The Movie Database",
  });

  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const titulo = interaction.options.getString("titulo", true);

  if (!process.env["TMDB_API_KEY"]) {
    await interaction.reply({
      content:
        "❌ O comando `/filme` requer a chave de API do TMDB.\n" +
        "Configure a variável de ambiente `TMDB_API_KEY` para usar esta função.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const results = await searchAnimeMovieTMDB(titulo);

    if (!results.length) {
      await interaction.editReply(
        `❌ Nenhum filme anime encontrado para **${titulo}**.\n` +
          "💡 Tente usar o título em inglês ou japonês."
      );
      return;
    }

    // Resultado único — busca detalhes completos
    if (results.length === 1) {
      const details = await getAnimeMovieDetails(results[0]!.id);
      const embed = await buildFilmeEmbed(details ?? results[0]!);
      await interaction.editReply({ content: null, embeds: [embed] });
      return;
    }

    // Múltiplos resultados — menu de seleção
    const options = results.slice(0, 8).map((r) => ({
      label: r.title.slice(0, 100),
      description: [
        r.releaseDate ? r.releaseDate.slice(0, 4) : "?",
        r.score ? `⭐ ${r.score.toFixed(1)}` : "",
        r.isDubbed ? "🇧🇷 PT-BR" : "",
      ]
        .filter(Boolean)
        .join(" • ")
        .slice(0, 100),
      value: String(r.id),
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("filme_select")
        .setPlaceholder("Selecione o filme correto")
        .addOptions(options)
    );

    await interaction.editReply({
      content: `🎬 Encontrei **${results.length}** filmes. Selecione o correto:`,
      components: [row],
    });

    const collector = interaction.channel?.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) =>
        i.customId === "filme_select" && i.user.id === interaction.user.id,
      time: 30_000,
      max: 1,
    });

    collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
      await sel.deferUpdate();
      try {
        const id = parseInt(sel.values[0]!, 10);
        const details = await getAnimeMovieDetails(id);
        if (!details) {
          await interaction.editReply({
            content: "❌ Não foi possível carregar os detalhes.",
            components: [],
          });
          return;
        }
        const embed = await buildFilmeEmbed(details);
        await interaction.editReply({
          content: null,
          embeds: [embed],
          components: [],
        });
      } catch {
        await interaction.editReply({
          content: "❌ Erro ao buscar detalhes. Tente novamente.",
          components: [],
        });
      }
    });

    collector?.on("end", async (_c, reason) => {
      if (reason === "time") {
        await interaction.editReply({
          content: "⏱️ Tempo esgotado. Use `/filme` novamente.",
          components: [],
        });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await interaction.editReply(`❌ Erro ao buscar filme: ${msg}`);
  }
}
