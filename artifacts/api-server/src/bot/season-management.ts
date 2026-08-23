import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { eq } from "drizzle-orm";
import { db, botConfigTable } from "@workspace/db";
import { config, syncConfiguredChannel } from "../routes/discord.js";

export const configurarData = new SlashCommandBuilder()
  .setName("temporada-configurar")
  .setDescription("Configura o canal da lista automática da temporada")
  .addChannelOption((option) => option
    .setName("canal")
    .setDescription("Canal onde a lista será publicada")
    .setRequired(true));

export const atualizarData = new SlashCommandBuilder()
  .setName("temporada-atualizar")
  .setDescription("Atualiza agora a lista da temporada");

export const statusData = new SlashCommandBuilder()
  .setName("temporada-status")
  .setDescription("Mostra o status da lista automática da temporada");

export const configurarCommand = {
  data: configurarData,
  async execute(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel("canal", true);
    const current = await config();
    await db.update(botConfigTable).set({ guildId: interaction.guildId, channelId: channel.id, enabled: true }).where(eq(botConfigTable.id, current.id));
    await interaction.reply({ content: "A lista será atualizada em <#" + channel.id + ">. Sincronizando a primeira versão agora.", ephemeral: true });
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

export const statusCommand = {
  data: statusData,
  async execute(interaction: ChatInputCommandInteraction) {
    const current = await config();
    await interaction.reply({ content: current.channelId ? "Lista ativa em <#" + current.channelId + ">. Próxima atualização conforme o intervalo configurado (" + current.intervalMinutes + " min)." : "Nenhum canal foi configurado. Use /temporada-configurar e escolha um canal.", ephemeral: true });
  },
};