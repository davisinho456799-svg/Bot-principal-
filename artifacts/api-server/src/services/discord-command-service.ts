import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { monitoredWorksTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";

const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("manhwa")
    .setDescription("Gerencia os manhwas monitorados")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((command) =>
      command
        .setName("adicionar")
        .setDescription("Adiciona um manhwa à monitoração")
        .addStringOption((option) =>
          option
            .setName("link")
            .setDescription("URL pública da obra ou da lista de capítulos")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("nome")
            .setDescription("Nome da obra; se omitido, será obtido do link")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("plataforma")
            .setDescription("Informe apenas se o domínio não identificar a plataforma")
            .addChoices(
              { name: "Lezhin", value: "lezhin" },
              { name: "Toomics", value: "toomics" },
              { name: "Toptoon", value: "toptoon" },
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((command) =>
      command.setName("listar").setDescription("Lista os manhwas ativos"),
    ),
].map((command) => command.toJSON());

type Platform = "lezhin" | "toomics" | "toptoon";

function detectPlatform(link: string): Platform | null {
  const hostname = new URL(link).hostname.toLowerCase();
  if (hostname.includes("lezhin")) return "lezhin";
  if (hostname.includes("toomics")) return "toomics";
  if (hostname.includes("toptoon")) return "toptoon";
  return null;
}

function titleFromUrl(link: string) {
  const url = new URL(link);
  const slug = decodeURIComponent(url.pathname)
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return slug || url.hostname.replace(/^www\./, "");
}

function normalizeUrl(link: string) {
  const url = new URL(link);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("O link precisa começar com http:// ou https://.");
  }
  return url.toString();
}

async function replyError(interaction: ChatInputCommandInteraction, message: string) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: `❌ ${message}` });
  } else {
    await interaction.reply({ content: `❌ ${message}`, ephemeral: true });
  }
}

async function handleAdd(interaction: ChatInputCommandInteraction) {
  const rawLink = interaction.options.getString("link", true).trim();
  const requestedTitle = interaction.options.getString("nome")?.trim();
  const requestedPlatform = interaction.options.getString("plataforma") as Platform | null;

  let listingUrl: string;
  try {
    listingUrl = normalizeUrl(rawLink);
  } catch (error) {
    await replyError(interaction, error instanceof Error ? error.message : "Link inválido.");
    return;
  }

  const platform = requestedPlatform ?? detectPlatform(listingUrl);
  if (!platform) {
    await replyError(
      interaction,
      "Não consegui identificar a plataforma. Use `plataforma: Lezhin`, `Toomics` ou `Toptoon`.",
    );
    return;
  }

  const [existing] = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.listingUrl, listingUrl))
    .limit(1);
  if (existing) {
    await interaction.reply({
      content: `ℹ️ **${existing.title}** já está cadastrado como ${existing.active ? "ativo" : "pausado"}.\n${existing.listingUrl}`,
      ephemeral: true,
    });
    return;
  }

  const title = requestedTitle || titleFromUrl(listingUrl);
  const [work] = await db
    .insert(monitoredWorksTable)
    .values({ title, platform, listingUrl, active: true })
    .returning();

  await interaction.reply({
    content: [
      `✅ **${work.title}** agora está sendo monitorado.`,
      `Plataforma: ${platform}`,
      `A primeira verificação será feita na próxima rodada e criará a linha de base sem repostar o histórico.`,
      `ID da obra: ${work.id}`,
    ].join("\n"),
    ephemeral: true,
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const works = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.active, true))
    .orderBy(desc(monitoredWorksTable.createdAt));

  if (!works.length) {
    await interaction.reply({
      content: "Ainda não há manhwas ativos. Use `/manhwa adicionar` para cadastrar o primeiro.",
      ephemeral: true,
    });
    return;
  }

  const lines = works.map(
    (work) => `• **${work.title}** · ${work.platform} · ID ${work.id}\n  ${work.listingUrl}`,
  );
  await interaction.reply({
    content: `📚 **Manhwas monitorados (${works.length})**\n${lines.join("\n")}`.slice(0, 1900),
    ephemeral: true,
  });
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "adicionar") {
    await handleAdd(interaction);
    return;
  }
  if (subcommand === "listar") {
    await handleList(interaction);
  }
}

async function registerCommands(client: Client<true>) {
  const configuredGuildId = process.env.DISCORD_GUILD_ID;
  const guilds = configuredGuildId
    ? [client.guilds.cache.get(configuredGuildId)].filter(Boolean)
    : [...client.guilds.cache.values()];

  await Promise.all(guilds.map((guild) => guild!.commands.set(commandDefinitions)));
  logger.info(
    { guildCount: guilds.length, configuredGuildId: configuredGuildId ?? null },
    "Discord manhwa commands registered",
  );
}

export function startDiscordCommandBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Discord commands are disabled");
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, (readyClient) => {
    void registerCommands(readyClient).catch((error) => {
      logger.error({ err: error }, "Discord command registration failed");
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "manhwa") return;
    void handleInteraction(interaction).catch((error) => {
      logger.error({ err: error }, "Discord manhwa command failed");
      void replyError(interaction, "Não foi possível concluir o comando agora.");
    });
  });
  void client.login(token).catch((error) => {
    logger.error({ err: error }, "Discord command bot login failed");
  });
}