import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

const EMBED_DESCRIPTION_LIMIT = 4096;

export const data = new SlashCommandBuilder()
  .setName("embed")
  .setDescription("Publica uma mensagem como embed neste canal")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("mensagem")
      .setDescription("Texto que aparecerá no embed")
      .setMinLength(1)
      .setMaxLength(EMBED_DESCRIPTION_LIMIT)
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

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "❌ Você precisa ser administrador para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.appPermissions?.has(PermissionFlagsBits.EmbedLinks)) {
    await interaction.reply({
      content: "❌ Preciso da permissão **Inserir links** neste canal para publicar o embed.",
      ephemeral: true,
    });
    return;
  }

  const message = interaction.options.getString("mensagem", true);
  if (!message.trim()) {
    await interaction.reply({
      content: "❌ Escreva uma mensagem para o embed.",
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setDescription(message)
    .setColor(0x5865f2);

  await interaction.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}
