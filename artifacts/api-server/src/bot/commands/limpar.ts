import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("limpar")
  .setDescription("Apaga mensagens recentes deste canal")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((option) =>
    option
      .setName("quantidade")
      .setDescription("Quantidade de mensagens recentes para apagar")
      .setMinValue(1)
      .setMaxValue(100)
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "❌ Este comando só pode ser usado em um servidor.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: "❌ Você precisa da permissão **Gerenciar mensagens** para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !("bulkDelete" in channel) || typeof channel.bulkDelete !== "function") {
    await interaction.reply({
      content: "❌ Este canal não permite apagar mensagens em massa.",
      ephemeral: true,
    });
    return;
  }

  const amount = interaction.options.getInteger("quantidade", true);
  await interaction.deferReply({ ephemeral: true });

  const deleted = await channel.bulkDelete(amount, true);
  await interaction.editReply(
    `✅ ${deleted.size} mensagem(ns) recente(s) apagada(s) neste canal.`,
  );
}