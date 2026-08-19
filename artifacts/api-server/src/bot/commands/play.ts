import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { getOrCreateQueue, resolveTrack, QUEUE_LIMIT } from "../music-queue.js";

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Toca uma música do YouTube — link ou nome")
  .addStringOption((opt) =>
    opt
      .setName("musica")
      .setDescription("Link do YouTube ou nome da música")
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString("musica", true).trim();

  // Verificar se usuário está em canal de voz
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: "❌ Você precisa estar em um canal de voz para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "❌ Este comando só funciona em servidores.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const track = await resolveTrack(query, interaction.user.username);

  if (!track) {
    await interaction.editReply(
      `❌ Não encontrei nenhuma música para **${query}**. Tente outro nome ou link.`
    );
    return;
  }

  const queue = getOrCreateQueue(
    interaction.guildId,
    voiceChannel.id,
    interaction.guild.voiceAdapterCreator
  );

  // Guarda o canal para notificar erros de streaming
  if (interaction.channel) queue.notifyChannel = interaction.channel;

  if (queue.queue.length >= QUEUE_LIMIT) {
    await interaction.editReply(
      `❌ A fila está cheia (limite de ${QUEUE_LIMIT} músicas). Use **/pular** ou **/cancelar** para liberar espaço.`
    );
    return;
  }

  const wasIdle = queue.isIdle && !queue.current;

  queue.queue.push(track);

  if (wasIdle) {
    // Começa a tocar imediatamente
    await queue._playNext();

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle("▶️ Tocando agora")
      .setDescription(`**[${track.title}](${track.url})**`)
      .addFields(
        { name: "⏱️ Duração", value: track.durationStr, inline: true },
        { name: "👤 Pedido por", value: track.requestedBy, inline: true }
      )
      .setFooter({ text: `Fila: ${queue.queue.length} música(s) restante(s)` });

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    await interaction.editReply({ embeds: [embed] });
  } else {
    const position = queue.queue.length; // posição na fila (já foi adicionada acima)
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Adicionado à fila")
      .setDescription(`**[${track.title}](${track.url})**`)
      .addFields(
        { name: "⏱️ Duração", value: track.durationStr, inline: true },
        { name: "👤 Pedido por", value: track.requestedBy, inline: true },
        { name: "📌 Posição na fila", value: String(position), inline: true }
      );

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    await interaction.editReply({ embeds: [embed] });
  }
}
