import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLavalinkPlayer } from "../lavalink.js";

export const data = new SlashCommandBuilder().setName("pause").setDescription("Pausa ou retoma a música atual");

export async function execute(interaction: ChatInputCommandInteraction) {
  const player = getLavalinkPlayer(interaction.guildId ?? "");
  if (!player?.current) {
    await interaction.reply({ content: "❌ Não há nenhuma música tocando no momento.", ephemeral: true });
    return;
  }
  if (player.paused) {
    await player.pause(false);
    await interaction.reply("▶️ Música retomada.");
  } else {
    await player.pause(true);
    await interaction.reply("⏸️ Música pausada.");
  }
}
