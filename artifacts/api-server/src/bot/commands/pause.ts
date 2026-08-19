import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../music-queue.js";

export const data = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pausa ou retoma a música atual");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só funciona em servidores.", ephemeral: true });
    return;
  }

  const queue = getQueue(interaction.guildId);

  if (!queue || !queue.current) {
    await interaction.reply({ content: "❌ Não há nenhuma música tocando no momento.", ephemeral: true });
    return;
  }

  if (queue.isPaused) {
    const resumed = queue.resume();
    if (resumed) {
      await interaction.reply(`▶️ Música retomada: **${queue.current.title}**`);
    } else {
      await interaction.reply({ content: "❌ Não foi possível retomar a música.", ephemeral: true });
    }
  } else {
    const paused = queue.pause();
    if (paused) {
      await interaction.reply(`⏸️ Música pausada: **${queue.current.title}**`);
    } else {
      await interaction.reply({ content: "❌ Não foi possível pausar a música.", ephemeral: true });
    }
  }
}
