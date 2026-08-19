import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../music-queue.js";

export const data = new SlashCommandBuilder()
  .setName("cancelar")
  .setDescription("Para a música e limpa toda a fila de reprodução");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só funciona em servidores.", ephemeral: true });
    return;
  }

  const queue = getQueue(interaction.guildId);

  if (!queue) {
    await interaction.reply({ content: "❌ Não há nada tocando no momento.", ephemeral: true });
    return;
  }

  const queueSize = queue.queue.length;
  queue.stop();

  const msg = queueSize > 0
    ? `⏹️ Reprodução cancelada e ${queueSize} música(s) removida(s) da fila.`
    : "⏹️ Reprodução cancelada.";

  await interaction.reply(msg);
}
