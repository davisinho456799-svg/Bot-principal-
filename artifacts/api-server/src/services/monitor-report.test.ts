import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits, type Client, type ChatInputCommandInteraction } from "discord.js";
const mocks = vi.hoisted(() => ({
  collectReport: vi.fn(), imageDestination: vi.fn(), getReportConfig: vi.fn(), configureReport: vi.fn(),
  dueReports: vi.fn(), claimReport: vi.fn(), completeReport: vi.fn(), failReport: vi.fn(),
}));
vi.mock("./monitor-report-store", () => mocks);
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { formatMonitorReport, REPORT_INTERVAL_MS, type MonitorReportData } from "./monitor-report-format";
import { handleMonitorReportCommand, reportForGuild, sendDueMonitorReports, validateReportChannel } from "./monitor-report-service";

const now = new Date("2026-10-08T15:00:00Z");
const config = () => ({ guildId: "guild-1", channelId: "channel-1", enabled: true,
  nextReportAt: now, lastReportAt: null, lastError: null });
const section = () => ({ available: true, works: 2, messages: 0, latestCheck: now, latestDelivery: null,
  pending: 0, errors: 0, latestError: null, failedWorks: 0 });
const data = (): MonitorReportData => ({ now, image: section(), embed: section() });
function client(channelGuild = "guild-1", permitted = true) {
  return { channels: { fetch: vi.fn(async () => ({
    id: "channel-1", type: ChannelType.GuildText, guildId: channelGuild,
    guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => permitted }),
  })) } } as unknown as Client;
}
function interaction({ configure = false, admin = true, channel = null as null | { id: string },
  enabled = null as boolean | null } = {}) {
  return {
    guildId: "guild-1", client: client(), memberPermissions: { has: () => admin },
    options: { getChannel: () => channel, getBoolean: () => enabled },
    editReply: vi.fn(), configure,
  } as unknown as ChatInputCommandInteraction;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.imageDestination.mockResolvedValue("image-channel");
  mocks.collectReport.mockResolvedValue(data());
});
describe("monitor report presentation and privacy", () => {
  it("has separate image and embed sections and a 24-hour interval", () => {
    const embed = formatMonitorReport(data()).toJSON();
    expect(embed.fields?.map(field => field.name)).toEqual(["Monitor por imagem", "Monitor por embed"]);
    expect(REPORT_INTERVAL_MS).toBe(86400000);
    expect(embed.fields?.[0]?.value).toContain("Mensagens confirmadas nas últimas 24h: **0**");
    expect(embed.description).toContain("Não executa verificações");
  });
  it("distinguishes an unknown timestamp from no deliveries and warns for stale checks", () => {
    const report = data();
    report.image.latestCheck = new Date(now.getTime() - 3 * 3600000);
    report.embed.latestCheck = null;
    const fields = formatMonitorReport(report).toJSON().fields!;
    expect(fields[0]!.value).toContain("Atenção");
    expect(fields[1]!.value).toContain("Sem registro");
    expect(fields[1]!.value).toContain("Atenção");
  });
  it("shows recent failures, pending chapters and text-only sends", () => {
    const report = data();
    report.image.errors = 2; report.image.pending = 3; report.image.textOnly = 1;
    report.image.latestError = now;
    const embed = formatMonitorReport(report).toJSON();
    expect(embed.color).toBe(0xf59e0b);
    expect(embed.fields?.[0]?.value).toContain("Capítulos pendentes: **3**");
    expect(embed.fields?.[0]?.value).toContain("sem imagem");
  });
  it("does not expose another guild's image monitor", async () => {
    await reportForGuild(client("other-guild"), "guild-1", now);
    expect(mocks.collectReport).toHaveBeenCalledWith("guild-1", null, now);
  });
  it("does not infer scope from an inaccessible image channel", async () => {
    const bot = client();
    vi.mocked(bot.channels.fetch).mockRejectedValue(new Error("no access"));
    await reportForGuild(bot, "guild-1", now);
    expect(mocks.collectReport).toHaveBeenCalledWith("guild-1", null, now);
  });
  it("uses the configured image channel only inside its own guild", async () => {
    await reportForGuild(client(), "guild-1", now);
    expect(mocks.collectReport).toHaveBeenCalledWith("guild-1", "image-channel", now);
  });
  it("marks an unconfigured monitor as unavailable instead of successful", () => {
    const report = data(); report.image.available = false;
    expect(formatMonitorReport(report).toJSON().fields![0]!.value).toContain("Não configurado");
  });
});
describe("manual summary and daily report configuration", () => {
  it("denies users without ManageGuild without collecting data", async () => {
    const command = interaction({ admin: false });
    await handleMonitorReportCommand(command, false);
    expect(mocks.collectReport).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("Gerenciar servidor"));
  });
  it("a manual summary never changes configuration", async () => {
    const command = interaction();
    await handleMonitorReportCommand(command, false);
    expect(command.editReply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] }, embeds: expect.any(Array),
    }));
    expect(mocks.configureReport).not.toHaveBeenCalled();
  });
  it("an unconfigured automatic report gives the exact configuration command", async () => {
    const command = interaction();
    await handleMonitorReportCommand(command, true);
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("/monitor resumo_configurar"));
    expect(mocks.configureReport).not.toHaveBeenCalled();
  });
  it("persists a selected channel and confirms the first daily deadline without sending", async () => {
    mocks.configureReport.mockResolvedValue({ ...config(), nextReportAt: new Date(now.getTime() + REPORT_INTERVAL_MS) });
    const command = interaction({ channel: { id: "channel-1" }, enabled: true });
    await handleMonitorReportCommand(command, true);
    expect(mocks.configureReport).toHaveBeenCalledWith("guild-1", "channel-1", true);
    expect(command.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Nenhum aviso foi enviado agora"),
    }));
  });
  it("pauses the report without requiring access to a deleted channel", async () => {
    mocks.getReportConfig.mockResolvedValue(config());
    mocks.configureReport.mockResolvedValue({ ...config(), enabled: false });
    const command = interaction({ enabled: false });
    await handleMonitorReportCommand(command, true);
    expect(command.client.channels.fetch).not.toHaveBeenCalled();
    expect(mocks.configureReport).toHaveBeenCalledWith("guild-1", "channel-1", false);
  });
  it("shows a paused configuration without suggesting a scheduled send", async () => {
    mocks.getReportConfig.mockResolvedValue({ ...config(), enabled: false });
    const command = interaction();
    await handleMonitorReportCommand(command, true);
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("Não haverá envio automático"));
    expect(mocks.configureReport).not.toHaveBeenCalled();
  });
  it("rejects another guild's channel and insufficient permissions", async () => {
    await expect(validateReportChannel(client("other-guild"), "guild-1", "channel-1"))
      .rejects.toThrow("deste servidor");
    await expect(validateReportChannel(client("guild-1", false), "guild-1", "channel-1"))
      .rejects.toThrow("O bot precisa");
  });
});
describe("daily sender and restart recovery", () => {
  function deps() {
    return { due: vi.fn(async () => [config()]), claim: vi.fn(async () => true),
      complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
      send: vi.fn(async () => "message-1"), now: () => now };
  }
  it("sends one overdue summary after a restart and acknowledges only after sending", async () => {
    const test = deps();
    await sendDueMonitorReports(test);
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.complete).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "message-1", now);
    expect(test.fail).not.toHaveBeenCalled();
  });
  it("does not send when another process owns the lease", async () => {
    const test = deps(); test.claim.mockResolvedValue(false);
    await sendDueMonitorReports(test);
    expect(test.send).not.toHaveBeenCalled();
  });
  it("does not send disabled reports or deadlines still in the future", async () => {
    const test = deps();
    test.due.mockResolvedValue([{ ...config(), enabled: false },
      { ...config(), nextReportAt: new Date(now.getTime() + 1) }]);
    await sendDueMonitorReports(test);
    expect(test.claim).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
  });
  it("a Discord failure retains a retry rather than falsely confirming a daily send", async () => {
    const test = deps(); test.send.mockRejectedValue(new Error("Discord unavailable"));
    await sendDueMonitorReports(test);
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.fail).toHaveBeenCalledTimes(1);
  });
  it("uses a stable nonce for retries of the same scheduled report", async () => {
    const test = deps();
    await sendDueMonitorReports(test); await sendDueMonitorReports(test);
    expect(test.send.mock.calls[0]![1]).toEqual(test.send.mock.calls[1]![1]);
    expect(test.send.mock.calls[0]![1]).toHaveLength(24);
  });
});
