/**
 * Comando /temas — mostra aberturas (OPs) e encerramentos (EDs) de um anime.
 * Fonte: AnimeThemes
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { searchAnimeThemes, type AnimeTheme } from "../animethemes.js";

export const data = new SlashCommandBuilder()
  .setName("temas")
  .setDescription("Mostra as aberturas e encerramentos de um anime")
  .addStringOption((opt) =>
    opt
      .setName("anime")
      .setDescription("Nome do anime (ex: Attack on Titan, Naruto, One Piece)")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("tipo")
      .setDescription("Filtrar por tipo (padrão: todos)")
      .setRequired(false)
      .addChoices(
        { name: "Todos", value: "todos" },
        { name: "Aberturas (OP)", value: "OP" },
        { name: "Encerramentos (ED)", value: "ED" }
      )
  );

function themeLabel(theme: AnimeTheme): string {
  const typeLabel = theme.type === "OP" ? "Abertura" : "Encerramento";
  const seqLabel = theme.sequence ? ` ${theme.sequence}` : "";
  return `${typeLabel}${seqLabel}`;
}

function themeEmoji(type: "OP" | "ED"): string {
  return type === "OP" ? "🎵" : "🎶";
}

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const animeName = interaction.options.getString("anime", true);
  const tipoFilter = interaction.options.getString("tipo") ?? "todos";

  await interaction.deferReply();

  try {
    const result = await searchAnimeThemes(animeName);

    if (!result || !result.themes.length) {
      await interaction.editReply(
        `❌ Nenhuma abertura ou encerramento encontrado para **${animeName}**.\n` +
          "💡 Tente usar o nome original em inglês (ex: *Fullmetal Alchemist: Brotherhood*)."
      );
      return;
    }

    // Filtra por tipo se necessário
    const themes =
      tipoFilter === "todos"
        ? result.themes
        : result.themes.filter((t) => t.type === tipoFilter);

    if (!themes.length) {
      const typeName = tipoFilter === "OP" ? "aberturas" : "encerramentos";
      await interaction.editReply(
        `❌ Nenhuma ${typeName} encontrada para **${result.animeName}**.`
      );
      return;
    }

    const ops = themes.filter((t) => t.type === "OP");
    const eds = themes.filter((t) => t.type === "ED");

    function formatTheme(t: AnimeTheme): string {
      const emoji = themeEmoji(t.type);
      const label = themeLabel(t);
      const artists =
        t.artists.length > 0 ? ` — *${t.artists.join(", ")}*` : "";
      const eps = t.episodes ? ` (Eps. ${t.episodes})` : "";
      const link = t.videoUrl ? ` [▶ Ver](${t.videoUrl})` : "";
      return `${emoji} **${label}:** ${t.songTitle}${artists}${eps}${link}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎼 Temas de ${result.animeName}`)
      .setURL(`https://animethemes.moe/anime/${result.animeSlug}`)
      .setColor(0x7289da)
      .setFooter({ text: "AnimeThemes.moe • Base de dados de temas de anime" });

    if (ops.length > 0) {
      embed.addFields({
        name: `🎵 Aberturas (${ops.length})`,
        value: ops.map(formatTheme).join("\n"),
        inline: false,
      });
    }

    if (eds.length > 0) {
      embed.addFields({
        name: `🎶 Encerramentos (${eds.length})`,
        value: eds.map(formatTheme).join("\n"),
        inline: false,
      });
    }

    // Botão para ver todos no site
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Ver todos no AnimeThemes")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://animethemes.moe/anime/${result.animeSlug}`)
        .setEmoji("🔗")
    );

    // Se tiver vídeos com NC (versão sem créditos), mostra aviso
    const hasNC = themes.some((t) => t.videoNC);
    if (hasNC) {
      embed.setDescription(
        "💡 Alguns temas possuem versão sem créditos (NC) disponível no site."
      );
    }

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await interaction.editReply(
      `❌ Erro ao buscar temas: ${msg}\nTente novamente em instantes.`
    );
  }
}
