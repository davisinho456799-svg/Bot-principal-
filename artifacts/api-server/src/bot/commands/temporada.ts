/**
 * Comando /temporada — exibe os animes da temporada atual, próxima ou anterior.
 * Fonte: AniList (season query).
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import {
  getSeasonAnimePage,
  getSeasonInfo,
  type SeasonAnimeItem,
} from "../../routes/season-service-data.js";
import { eq } from "drizzle-orm";
import { db, botConfigTable } from "@workspace/db";
import { config, syncConfiguredChannel } from "../../routes/discord.js";

// ─── Temporada ────────────────────────────────────────────────────────────────

const SEASON_NAMES: Record<string, string> = {
  WINTER: "Inverno",
  SPRING: "Primavera",
  SUMMER: "Verão",
  FALL: "Outono",
};

const SEASON_EMOJI: Record<string, string> = {
  WINTER: "❄️",
  SPRING: "🌸",
  SUMMER: "☀️",
  FALL: "🍂",
};

const STATUS_PT: Record<string, string> = {
  RELEASING: "🟢 Airing",
  FINISHED: "✅ Finalizado",
  NOT_YET_RELEASED: "🔜 Em breve",
  CANCELLED: "❌ Cancelado",
  HIATUS: "⏸️ Hiato",
};

// ─── Busca ────────────────────────────────────────────────────────────────────

// ─── Embed ────────────────────────────────────────────────────────────────────

function buildSeasonEmbed(list: SeasonAnimeItem[], season: string, year: number, page: number): EmbedBuilder {
  const emoji = SEASON_EMOJI[season] ?? "🎌";
  const seasonName = SEASON_NAMES[season] ?? season;

  const rawColor = list[0]?.coverImage.color
    ? parseInt(list[0].coverImage.color.replace("#", ""), 16)
    : NaN;
  const color = Number.isFinite(rawColor) && rawColor > 0 ? rawColor : 0x02a9ff;

  const lines = list.map((m, i) => {
    const title = m.title.english ?? m.title.romaji;
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const eps = m.episodes ? `📺 ${m.episodes} eps` : m.nextAiringEpisode ? `📺 Ep ${m.nextAiringEpisode.episode}` : "📺 ?";
    const studio = m.studios.nodes[0]?.name ?? "—";
    const status = STATUS_PT[m.status] ?? m.status;
    const genres = m.genres.slice(0, 2).join(", ") || "—";
    return `**${(page - 1) * 20 + i + 1}.** [${title}](${m.siteUrl})\n> ${score} | ${eps} | ${status}\n> 🏢 ${studio} • 🏷️ ${genres}`;
  });

  return new EmbedBuilder()
    .setTitle(`${emoji} Temporada ${seasonName} ${year}`)
    .setDescription(lines.join("\n\n").slice(0, 4000))
    .setColor(color)
    .setFooter({ text: `Página ${page} • Ordenado por popularidade • Fonte: ${list[0]?.source ?? "AniList"}` });
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("temporada")
  .setDescription("Exibe os animes da temporada atual, próxima ou anterior")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Qual temporada ver")
      .setRequired(false)
      .addChoices(
        { name: "Atual", value: "atual" },
        { name: "Próxima", value: "proxima" },
        { name: "Anterior", value: "anterior" },
      )
  )
  .addIntegerOption((opt) =>
    opt
      .setName("ano")
      .setDescription("Ano específico (ex: 2025)")
      .setRequired(false)
      .setMinValue(1990)
      .setMaxValue(2030)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "atual";
  const anoOpt = interaction.options.getInteger("ano");

  await interaction.deferReply();

  let seasonInfo: { season: string; year: number };
  if (anoOpt) {
    const base = getSeasonInfo(0);
    seasonInfo = { season: base.season, year: anoOpt };
  } else {
    switch (periodo) {
      case "proxima":  seasonInfo = getSeasonInfo(3);  break;
      case "anterior": seasonInfo = getSeasonInfo(-3); break;
      default:         seasonInfo = getSeasonInfo(0);  break;
    }
  }

  const { season, year } = seasonInfo;

  try {
    const list = await getSeasonAnimePage(season, year, 1);

    if (!list.length) {
      const seasonName = SEASON_NAMES[season] ?? season;
      await interaction.editReply(`❌ Nenhum anime encontrado para a temporada **${seasonName} ${year}**.`);
      return;
    }

    const embed = buildSeasonEmbed(list, season, year, 1);
    const seasonName = SEASON_NAMES[season] ?? season;
    const emoji = SEASON_EMOJI[season] ?? "🎌";

    // Se houver mais que 10 resultados, oferece navegação por select
    if (list.length >= 10) {
      const pageOptions = [
        { label: `${emoji} Página 1 (1–20)`, value: "1" },
        { label: `${emoji} Página 2 (21–40)`, value: "2" },
      ];
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("temporada_page")
          .setPlaceholder("Ver mais animes da temporada")
          .addOptions(pageOptions)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });

      const collector = interaction.channel?.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === "temporada_page" && i.user.id === interaction.user.id,
        time: 60_000,
        max: 3,
      });

      collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();
        const pg = parseInt(sel.values[0]!, 10);
        try {
          const nextList = await getSeasonAnimePage(season, year, pg);
          const nextEmbed = buildSeasonEmbed(nextList, season, year, pg);
          await interaction.editReply({ embeds: [nextEmbed], components: [row] });
        } catch {
          await interaction.followUp({ content: "❌ Erro ao carregar a próxima página.", ephemeral: true });
        }
      });

      collector?.on("end", async (_c, reason) => {
        if (reason === "time") {
          await interaction.editReply({ components: [] }).catch(() => null);
        }
      });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    const seasonName = SEASON_NAMES[season] ?? season;
    await interaction.editReply(`❌ Erro ao buscar a temporada **${seasonName} ${year}**. Tente novamente.`);
  }
}

export const configurarData = new SlashCommandBuilder()
  .setName("temporada-configurar")
  .setDescription("Configura o canal da lista automática da temporada")
  .addChannelOption((option) =>
    option
      .setName("canal")
      .setDescription("Canal onde a lista será publicada")
      .setRequired(true),
  );

export const atualizarData = new SlashCommandBuilder()
  .setName("temporada-atualizar")
  .setDescription("Atualiza agora a lista da temporada");

export const temporadaStatusData = new SlashCommandBuilder()
  .setName("temporada-status")
  .setDescription("Mostra o status da lista automática da temporada");

export const configurarCommand = {
  data: configurarData,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel("canal", true);
    const current = await config();
    await db
      .update(botConfigTable)
      .set({ guildId: interaction.guildId, channelId: channel.id, enabled: true })
      .where(eq(botConfigTable.id, current.id));
    await interaction.editReply(
      `A lista será atualizada em <#${channel.id}>. Sincronizando a primeira versão agora.`,
    );
    await syncConfiguredChannel();
  },
};

export const atualizarCommand = {
  data: atualizarData,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await syncConfiguredChannel();
    await interaction.editReply(result.message);
  },
};

export const temporadaStatusCommand = {
  data: temporadaStatusData,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const current = await config();
    await interaction.editReply(
      current.channelId
        ? `Lista ativa em <#${current.channelId}>. Próxima atualização conforme o intervalo configurado (${current.intervalMinutes} min).`
        : "Nenhum canal foi configurado. Use /temporada-configurar e escolha um canal.",
    );
  },
};
