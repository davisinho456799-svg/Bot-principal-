import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLavalinkPlayer } from "../lavalink.js";

export const data = new SlashCommandBuilder().setName("pular").setDescription("Pula para a próxima música da fila");

export async function execute(interaction: ChatInputCommandInteraction) {
  const player = getLavalinkPlayer(interaction.guildId ?? "");
  if (!player?.current) {
    await interaction.reply({ content: "❌ Não há nenhuma música tocando no momento.", ephemeral: true });
    return;
  }
  const skipped = player.current.info?.title ?? "a música atual";
  const next = player.queue?.[0]?.info?.title;
  await player.stop();
  await interaction.reply(next ? "⏭️ Pulei **" + skipped + "**. Próxima: **" + next + "**" : "⏭️ Pulei **" + skipped + "**.");
}
