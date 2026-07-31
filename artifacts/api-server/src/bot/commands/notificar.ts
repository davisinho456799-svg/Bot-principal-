import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from "discord.js";
import { db, notificacaoCanaisTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("notificar")
  .setDescription("Configura notificações de novos capítulos dos seus favoritos")
  .addSubcommand((sub) =>
    sub
      .setName("canal")
      .setDescription("Define o canal onde o bot avisará sobre novos capítulos")
      .addChannelOption((opt) =>
        opt
          .setName("canal")
          .setDescription("Canal de texto para as notificações")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Mostra o canal de notificações configurado")
  )
  .addSubcommand((sub) =>
    sub.setName("desativar").setDescription("Desativa as notificações de novos capítulos")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "canal") await handleCanal(interaction);
  else if (sub === "status") await handleStatus(interaction);
  else if (sub === "desativar") await handleDesativar(interaction);
}

async function handleCanal(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }

  const canal = interaction.options.getChannel("canal", true) as TextChannel;
  await interaction.deferReply({ ephemeral: true });

  await db
    .insert(notificacaoCanaisTable)
    .values({ guildId: interaction.guildId, channelId: canal.id })
    .onConflictDoUpdate({
      target: notificacaoCanaisTable.guildId,
      set: { channelId: canal.id, configuredAt: new Date() },
    });

  const embed = new EmbedBuilder()
    .setTitle("🔔 Notificações Configuradas!")
    .setColor(0x2ecc71)
    .setDescription(
      `O bot vai avisar em ${canal} sempre que um manhwa da lista de favoritos de alguém tiver **novos capítulos**.\n\n` +
      `> ✅ A verificação acontece automaticamente a cada **2 horas**.\n` +
      `> ✅ Somente manhwas marcados como favoritos com status "Em lançamento" são monitorados.\n` +
      `> ✅ Cada manhwa só gera uma notificação por atualização de capítulo.`
    )
    .setFooter({ text: "Use /notificar desativar para parar as notificações" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [config] = await db
    .select()
    .from(notificacaoCanaisTable)
    .where(eq(notificacaoCanaisTable.guildId, interaction.guildId));

  if (!config) {
    await interaction.editReply({
      content: "📭 Nenhum canal de notificações configurado.\nUse `/notificar canal #canal` para configurar.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🔔 Status das Notificações")
    .setColor(0x3498db)
    .addFields(
      { name: "Canal configurado", value: `<#${config.channelId}>`, inline: true },
      { name: "Configurado em", value: config.configuredAt.toLocaleDateString("pt-BR"), inline: true },
      { name: "Frequência de verificação", value: "A cada 2 horas", inline: false },
    )
    .setFooter({ text: "Use /notificar desativar para parar as notificações" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDesativar(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em servidores.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const deleted = await db
    .delete(notificacaoCanaisTable)
    .where(eq(notificacaoCanaisTable.guildId, interaction.guildId))
    .returning();

  if (!deleted.length) {
    await interaction.editReply({ content: "📭 Não havia notificações configuradas neste servidor." });
    return;
  }

  await interaction.editReply({ content: "🔕 Notificações desativadas com sucesso." });
}
