import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLavalinkPlayer } from "../lavalink.js";

export const data = new SlashCommandBuilder()
  .setName("pular")
  .setDescription("Pula para a próxima música da fila");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só funciona em servidores.", ephemeral: true });
    return;
  }

  const player = getLavalinkPlayer(interaction.guildId);

  if (!player?.current) {
    await interaction.reply({ content: "❌ Não há nenhuma música tocando no momento.", ephemeral: true });
    return;
  }

  const skipped = player.current.info?.title ?? "faixa atual";
  await player.stop();
  await interaction.reply(`⏭️ Pulei **${skipped}**.`);
}
