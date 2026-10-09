import { createHash, randomUUID } from "node:crypto";
import { ChannelType, PermissionFlagsBits, type Client, type ChatInputCommandInteraction } from "discord.js";
import { logger } from "../lib/logger";
import { formatMonitorReport } from "./monitor-report-format";
import * as store from "./monitor-report-store";

export async function validateReportChannel(client: Client, guildId: string, channelId: string) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) {
    throw new Error("Escolha um canal de texto deste servidor.");
  }
  const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error("O bot precisa visualizar o canal, enviar mensagens e inserir links/embeds.");
  }
  return channel;
}
export async function reportForGuild(client: Client, guildId: string, now = new Date()) {
  const destination = await store.imageDestination();
  let imageChannel: string | null = null;
  if (destination) {
    try {
      const channel = await client.channels.fetch(destination);
      if (channel && "guildId" in channel && channel.guildId === guildId) imageChannel = destination;
    } catch { /* An inaccessible image channel cannot establish a safe data scope. */ }
  }
  return formatMonitorReport(await store.collectReport(guildId, imageChannel, now));
}
export async function handleMonitorReportCommand(interaction: ChatInputCommandInteraction, configure: boolean) {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply("Este recurso exige a permissão Gerenciar servidor.");
    return;
  }
  if (!configure) {
    const embed = await reportForGuild(interaction.client, interaction.guildId);
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }
  const channel = interaction.options.getChannel("canal");
  const enabled = interaction.options.getBoolean("ativo");
  const current = await store.getReportConfig(interaction.guildId);
  if (!channel && enabled === null) {
    await interaction.editReply(current
      ? `Resumo diário **${current.enabled ? "ativado" : "pausado"}** em <#${current.channelId}>.\n${current.enabled
        ? `Próximo envio: <t:${Math.floor(current.nextReportAt.getTime() / 1000)}:F>.`
        : "Não haverá envio automático enquanto estiver pausado."}${current.lastError ? `\n${current.lastError}` : ""}`
      : "Resumo automático ainda não configurado. Use `/monitor resumo_configurar canal:#seu-canal ativo:true`. Recomendo um canal separado, acessível aos administradores.");
    return;
  }
  const channelId = channel?.id ?? current?.channelId;
  if (!channelId) throw new Error("Informe o canal para configurar o resumo diário.");
  const active = enabled ?? current?.enabled ?? true;
  if (active || channel) await validateReportChannel(interaction.client, interaction.guildId, channelId);
  const saved = await store.configureReport(interaction.guildId, channelId, active);
  if (!saved) throw new Error("Não foi possível confirmar a configuração.");
  await interaction.editReply({ content: active
    ? `Resumo diário ativado em <#${channelId}>, com imagem e embed em seções separadas.\nPrimeiro envio: <t:${Math.floor(saved.nextReportAt.getTime() / 1000)}:F>; depois, a cada 24 horas.\nOs canais de lançamentos e os intervalos dos monitores não mudaram. Nenhum aviso foi enviado agora.`
    : "Resumo automático pausado. O `/monitor resumo` continua disponível; os monitores não foram pausados.",
  allowedMentions: { parse: [] } });
}

export interface ReportSenderDependencies {
  due: typeof store.dueReports;
  claim: typeof store.claimReport;
  complete: typeof store.completeReport;
  fail: typeof store.failReport;
  send: (config: store.ReportConfig, nonce: string) => Promise<string>;
  now: () => Date;
}
export async function sendDueMonitorReports(deps: ReportSenderDependencies) {
  const now = deps.now();
  for (const config of await deps.due(now)) {
    const token = randomUUID();
    if (!config.enabled || config.nextReportAt > now || !await deps.claim(config, token, now)) continue;
    try {
      const nonce = createHash("sha256").update(`${config.guildId}:${config.nextReportAt.toISOString()}`)
        .digest("hex").slice(0, 24);
      const id = await deps.send(config, nonce);
      await deps.complete(config, token, id, deps.now());
    } catch (error) {
      await deps.fail(config, token, deps.now());
      logger.warn({ errorName: error instanceof Error ? error.name : "UnknownError" },
        "Resumo diário não enviado ou não confirmado; nova tentativa em 15 minutos");
    }
  }
}
let started = false;
export function startMonitorReportService(client: Client) {
  if (started) return;
  started = true;
  let busy = false, lastWarning = 0;
  const tick = async () => {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      await sendDueMonitorReports({
        due: store.dueReports, claim: store.claimReport, complete: store.completeReport, fail: store.failReport,
        now: () => new Date(),
        send: async (config, nonce) => {
          const channel = await validateReportChannel(client, config.guildId, config.channelId);
          const embed = await reportForGuild(client, config.guildId);
          return (await channel.send({ embeds: [embed], allowedMentions: { parse: [] }, nonce,
            enforceNonce: true })).id;
        },
      });
    } catch (error) {
      if (Date.now() - lastWarning > 900000) {
        lastWarning = Date.now();
        logger.warn({ errorName: error instanceof Error ? error.name : "UnknownError" },
          "Resumo diário indisponível; confira sua configuração e o schema. Os monitores continuam funcionando.");
      }
    } finally { busy = false; }
  };
  setTimeout(() => void tick(), 60000).unref();
  setInterval(() => void tick(), 60000).unref();
}
