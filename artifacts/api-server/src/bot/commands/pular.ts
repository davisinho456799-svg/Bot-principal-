import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../music-queue.js";

export const data = new SlashCommandBuilder()
  .setName("pular")
  .setDescription("Pula para a próxima música da fila");

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

  const skipped = queue.current.title;
  const next = queue.queue[0];

  queue.skip();

  if (next) {
    await interaction.reply(`⏭️ Pulei **${skipped}**\n▶️ Próxima: **${next.title}**`);
  } else {
    await interaction.reply(`⏭️ Pulei **${skipped}** — fila vazia, reprodução encerrada.`);
  }
}
