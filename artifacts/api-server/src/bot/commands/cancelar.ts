import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLavalinkPlayer } from "../lavalink.js";

export const data = new SlashCommandBuilder().setName("cancelar").setDescription("Para a música e limpa toda a fila");

export async function execute(interaction: ChatInputCommandInteraction) {
  const player = getLavalinkPlayer(interaction.guildId ?? "");
  if (!player) {
    await interaction.reply({ content: "❌ Não há nada tocando no momento.", ephemeral: true });
    return;
  }
  const removed = player.queue?.length ?? 0;
  player.queue.clear();
  await player.destroy();
  await interaction.reply(removed ? "⏹️ Reprodução cancelada e " + removed + " música(s) removida(s) da fila." : "⏹️ Reprodução cancelada.");
}
