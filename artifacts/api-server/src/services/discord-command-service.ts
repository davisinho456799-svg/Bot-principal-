import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { desc, eq, like } from "drizzle-orm";
import { db } from "@workspace/db";
import { monitorConfigTable, monitoredWorksTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { runMonitor, runTestNotification } from "./monitor-service.js";

export const monitorCommandDefinition = new SlashCommandBuilder()
    .setName("monitor")
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
    )
    .addSubcommand((command) =>
      command
        .setName("canal")
        .setDescription("Escolhe o canal que receberá as notificações")
        .addChannelOption((option) =>
          option
            .setName("canal")
            .setDescription("Canal de texto para as notificações")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("verificar").setDescription("Executa uma verificação agora"),
    )
    .addSubcommand((command) =>
      command
        .setName("teste")
        .setDescription("Testa uma obra específica ou escolhe uma aleatória")
        .addIntegerOption((option) =>
          option
            .setName("obra")
            .setDescription("ID da obra exibido pelo /monitor listar")
            .setRequired(false),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("remover")
        .setDescription("Remove uma obra da monitoração")
        .addIntegerOption((option) =>
          option
            .setName("id")
            .setDescription("ID exibido pelo /monitor listar")
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("erros").setDescription("Mostra os erros atuais do monitor"),
    )
    .toJSON();

const commandDefinitions = [monitorCommandDefinition];

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
    await interaction.editReply({
      content: `ℹ️ **${existing.title}** já está cadastrado como ${existing.active ? "ativo" : "pausado"}.\n${existing.listingUrl}`,
    });
    return;
  }

  const title = requestedTitle || titleFromUrl(listingUrl);
  const [work] = await db
    .insert(monitoredWorksTable)
    .values({ title, platform, listingUrl, active: true })
    .returning();

  await interaction.editReply({
    content: [
      `✅ **${work.title}** agora está sendo monitorado.`,
      `Plataforma: ${platform}`,
      `A primeira verificação será feita na próxima rodada e criará a linha de base sem repostar o histórico.`,
      `ID da obra: ${work.id}`,
    ].join("\n"),
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const works = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.active, true))
    .orderBy(desc(monitoredWorksTable.createdAt));

  if (!works.length) {
    await interaction.editReply({
      content: "Ainda não há manhwas ativos. Use `/monitor adicionar` para cadastrar o primeiro.",
    });
    return;
  }

  const lines = works.map(
    (work) => `• **${work.title}** · ${work.platform} · ID ${work.id}\n  ${work.listingUrl}`,
  );
  await interaction.editReply({
    content: `📚 **Manhwas monitorados (${works.length})**\n${lines.join("\n")}`.slice(0, 1900),
  });
}

async function handleSetChannel(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("canal", true);
  if (
    !("isTextBased" in channel) ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased() ||
    !("name" in channel)
  ) {
    await replyError(interaction, "Escolha um canal de texto válido.");
    return;
  }

  const [existing] = await db
    .select({ id: monitorConfigTable.id })
    .from(monitorConfigTable)
    .limit(1);

  if (existing) {
    await db
      .update(monitorConfigTable)
      .set({
        discordChannelId: channel.id,
        discordChannelName: channel.name,
        updatedAt: new Date(),
      })
      .where(eq(monitorConfigTable.id, existing.id));
  } else {
    await db.insert(monitorConfigTable).values({
      id: 1,
      discordChannelId: channel.id,
      discordChannelName: channel.name,
    });
  }

  await interaction.editReply({
    content: [
      "✅ Canal de notificações salvo.",
      `As próximas notificações serão enviadas em <#${channel.id}>.`,
      "Agora você pode usar `/monitor teste` para validar o envio.",
    ].join("\n"),
  });
}

export async function executeManhwaCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "adicionar") {
    await handleAdd(interaction);
    return;
  }
  if (subcommand === "listar") {
    await handleList(interaction);
    return;
  }
  if (subcommand === "canal") {
    await handleSetChannel(interaction);
    return;
  }
  if (subcommand === "verificar") {
    const result = await runMonitor();
    await interaction.editReply({
      content: [
        "✅ Verificação concluída.",
        `Obras verificadas: ${result.worksChecked}`,
        `Capítulos novos encontrados: ${result.chaptersFound}`,
        `Publicações enviadas: ${result.postsSent}`,
      ].join("\n"),
    });
    return;
  }
  if (subcommand === "teste") {
    const workId = interaction.options.getInteger("obra") ?? undefined;
    const progress: string[] = [];
    const updateProgress = async (message: string) => {
      progress.push(message);
      await interaction.editReply({
        content: [
          "🧭 **Caminho do teste**",
          ...progress.map((step, index) => `${index + 1}. ${step}`),
        ].join("\n"),
      });
    };

    try {
      const result = await runTestNotification(updateProgress, workId);
      await interaction.editReply({
        content: [
          "✅ **Resultado do teste**",
          ...progress.map((step, index) => `${index + 1}. ${step}`),
          "",
          "🧪 Notificação de teste enviada no canal do monitor.",
          `Título escolhido: **${result.title}**`,
          `Capítulo/imagem: ${result.chapter}`,
          `Parser usado: ${result.parser}`,
          `Modo da captura: ${result.captureMode}`,
        ].join("\n"),
      });
    } catch (error) {
      await replyError(
        interaction,
        error instanceof Error ? error.message : "Não foi possível enviar a notificação de teste.",
      );
    }
    return;
  }
  if (subcommand === "remover") {
    const workId = interaction.options.getInteger("id", true);
    const [work] = await db
      .update(monitoredWorksTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(monitoredWorksTable.id, workId))
      .returning();

    if (!work) {
      await interaction.editReply({
        content: `❌ Não encontrei nenhuma obra com o ID ${workId}. Use \`/monitor listar\` para conferir os IDs ativos.`,
      });
      return;
    }

    await interaction.editReply({
      content: [
        `🗑️ **${work.title}** foi removido da monitoração.`,
        "O histórico foi preservado e a obra pode ser reativada pelo painel.",
      ].join("\n"),
    });
    return;
  }
  if (subcommand === "erros") {
    const failedWorks = await db
      .select()
      .from(monitoredWorksTable)
      .where(like(monitoredWorksTable.lastStatus, "Check failed:%"))
      .orderBy(desc(monitoredWorksTable.lastCheckedAt));

    if (!failedWorks.length) {
      await interaction.editReply({
        content: "✅ Nenhuma obra está com erro no momento.",
      });
      return;
    }

    const lines = failedWorks.map((work) => [
      `• **${work.title}** · ID ${work.id}`,
      `  ${work.lastStatus}`,
      `  Última tentativa: ${work.lastCheckedAt?.toISOString() ?? "desconhecida"}`,
    ].join("\n"));
    await interaction.editReply({
      content: `⚠️ **Erros atuais do monitor (${failedWorks.length})**\n${lines.join("\n")}`.slice(0, 1900),
    });
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
    "Discord monitor commands registered",
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
    if (!interaction.isChatInputCommand() || interaction.commandName !== "monitor") return;
    void executeManhwaCommand(interaction).catch((error) => {
      logger.error({ err: error }, "Discord monitor command failed");
      void replyError(interaction, "Não foi possível concluir o comando agora.");
    });
  });
  void client.login(token).catch((error) => {
    logger.error({ err: error }, "Discord command bot login failed");
  });
}