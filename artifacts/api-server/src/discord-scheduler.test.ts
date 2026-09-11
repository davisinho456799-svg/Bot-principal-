import { describe, expect, it, vi } from "vitest";

const config = vi.fn(async () => ({
  id: 1,
  guildId: "guild-1",
  channelId: "channel-1",
  intervalMinutes: 1,
  includeAnime: true,
  includeManga: true,
  enabled: true,
  lastSyncedAt: null,
  messageId: null,
}));
const syncConfiguredChannel = vi.fn(async () => {
  throw new Error("AniList e Tenrai indisponíveis para o catálogo de anime");
});

vi.mock("./routes/discord.js", () => ({ config, syncConfiguredChannel }));

const { runScheduledSync } = await import("./discord-scheduler.js");

describe("scheduler da tabela de temporada", () => {
  it("absorve falha do catálogo sem rejeição não tratada", async () => {
    await expect(runScheduledSync()).resolves.toBeUndefined();
    expect(syncConfiguredChannel).toHaveBeenCalledTimes(1);
  });
});