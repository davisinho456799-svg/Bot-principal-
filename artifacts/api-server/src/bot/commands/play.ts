import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLavalink } from "../lavalink.js";
import { logger } from "../../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Toca uma música ou playlist pelo Lavalink")
  .addStringOption((opt) =>
    opt
      .setName("musica")
      .setDescription("Nome, link da música ou playlist")
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "❌ Este comando só funciona em servidores.", ephemeral: true });
    return;
  }

  const voiceChannel = interaction.guild.members.cache.get(interaction.user.id)?.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: "❌ Você precisa estar em um canal de voz para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  const manager = getLavalink();
  if (!manager) {
    await interaction.reply({
      content: "❌ O Lavalink não está configurado neste ambiente.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const query = interaction.options.getString("musica", true).trim();

  try {
    const player = manager.createConnection({
      guildId: interaction.guildId,
      voiceChannel: voiceChannel.id,
      textChannel: interaction.channelId,
      deaf: true,
    });
    const result: any = await Promise.race([
      manager.resolve({
        query,
        requester: {
          id: interaction.user.id,
          username: interaction.user.username,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Lavalink não respondeu em 15 segundos")), 15_000),
      ),
    ]);

    if (!result?.tracks?.length || !["search", "track", "playlist"].includes(result.loadType)) {
      await interaction.editReply("❌ Nenhuma música encontrada para essa busca.");
      return;
    }

    const tracks = result.loadType === "playlist" ? result.tracks : [result.tracks[0]];
    for (const track of tracks) {
      track.info.requester = interaction.user;
      player.queue.add(track);
    }

    if (!player.playing && !player.paused) await player.play();
    await interaction.editReply(
      tracks.length > 1
        ? `✅ ${tracks.length} músicas adicionadas à fila.`
        : `✅ Adicionada: **${tracks[0].info.title}**`,
    );
  } catch (error) {
    logger.error(
      { error, guildId: interaction.guildId, query },
      "Erro ao carregar música via Lavalink",
    );
    await interaction.editReply(
      "❌ Não consegui carregar essa música. Verifique a busca e a conexão com o Lavalink.",
    );
  }
}
