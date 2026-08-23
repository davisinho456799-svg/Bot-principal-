import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { eq } from "drizzle-orm";
import { db, botConfigTable } from "@workspace/db";
import { config, syncConfiguredChannel } from "./routes/discord";
import { logger } from "./lib/logger";

const commands = [
  new SlashCommandBuilder()
    .setName("temporada")
    .setDescription("Gerencia a lista de animes e mangás da temporada")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("configurar")
        .setDescription("Escolhe o canal que receberá a lista automática")
        .addChannelOption((option) =>
          option
            .setName("canal")
            .setDescription("Canal de texto onde a lista será publicada")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("atualizar").setDescription("Atualiza a lista agora"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Mostra o status da lista automática"),
    )
    .toJSON(),
];

export async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Discord bot is disabled");
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once("clientReady", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot connected");
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    logger.info("Discord slash commands registered");
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "temporada") return;

    try {
      if (interaction.options.getSubcommand() === "configurar") {
        const channel = interaction.options.getChannel("canal", true);
        const current = await config();
        await db.update(botConfigTable).set({
          guildId: interaction.guildId,
          channelId: channel.id,
          enabled: true,
        }).where(eq(botConfigTable.id, current.id));
        await interaction.reply({
          content: `A lista será atualizada em <#${channel.id}>. Sincronizando a primeira versão agora.`,
          ephemeral: true,
        });
        await syncConfiguredChannel();
        return;
      }

      if (interaction.options.getSubcommand() === "atualizar") {
        await interaction.deferReply({ ephemeral: true });
        const result = await syncConfiguredChannel();
        await interaction.editReply(result.message);
        return;
      }

      const current = await config();
      await interaction.reply({
        content: current.channelId
          ? `Lista ativa em <#${current.channelId}>. Próxima atualização conforme o intervalo configurado (${current.intervalMinutes} min).`
          : "Nenhum canal foi configurado. Use `/temporada configurar` e escolha um canal.",
        ephemeral: true,
      });
    } catch (error) {
      logger.error({ err: error }, "Discord command failed");
      const message = "Não consegui atualizar a lista agora. Verifique as permissões do bot no canal.";
      if (interaction.replied || interaction.deferred) await interaction.editReply(message);
      else await interaction.reply({ content: message, ephemeral: true });
    }
  });

  client.on("error", (error) => logger.error({ err: error }, "Discord client error"));
  await client.login(token);
}