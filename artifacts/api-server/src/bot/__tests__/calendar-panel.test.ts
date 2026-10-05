import { ComponentType, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCalendarPanel, buildCalendarResults, calendarCustomId,
  handleCalendarComponent, isAdultCalendarChannel, parseCalendarCustomId,
} from "../calendar-panel.js";
import { execute as normalCommand } from "../commands/calendario.js";
import { execute as adultCommand, data as adultDefinition } from "../commands/calendario18.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), lookup: vi.fn(), animeLookup: vi.fn(),
  insert: vi.fn(), values: vi.fn(), conflict: vi.fn(), returning: vi.fn(),
}));
vi.mock("../calendar-data.js", () => ({ loadCalendarEntries: mocks.load }));
vi.mock("../unified.js", () => ({
  getUnifiedById: mocks.lookup, getUnifiedAnimeById: mocks.animeLookup,
}));
vi.mock("@workspace/db", () => ({
  db: { insert: mocks.insert }, assinaturasTable: { id: "id" },
}));
vi.mock("../../lib/logger.js", () => ({ logger: { error: vi.fn() } }));

const state = { adult: false, tab: "anime", period: "hoje", page: 0, action: "open" } as const;
const entries = Array.from({ length: 23 }, (_, index) => ({
  id: String(index + 1), source: "anilist-anime" as const,
  title: `Anime ${index + 1}`, siteUrl: `https://anilist.co/anime/${index + 1}`,
  details: "Ep 1 — 05/10 às 12:00",
}));

let messageSequence = 0;
function interaction(customId = calendarCustomId(state), select = false, nsfw = false) {
  const fixture = {
    customId, user: { id: "person" }, guildId: "guild",
    channel: { nsfw }, message: { id: `message-${++messageSequence}`, components: [] as unknown[] },
    values: ["anilist-anime:1"],
    deferred: false, replied: false,
    isStringSelectMenu: () => select,
    reply: vi.fn(async () => { fixture.replied = true; }),
    deferReply: vi.fn(async () => { fixture.deferred = true; }),
    deferUpdate: vi.fn(async () => { fixture.deferred = true; }),
    editReply: vi.fn(async () => ({ id: fixture.message.id })), followUp: vi.fn(async () => undefined),
  };
  return fixture;
}
function asButton(value: ReturnType<typeof interaction>) {
  return value as unknown as ButtonInteraction;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(entries);
  mocks.lookup.mockResolvedValue({ mainTitle: "Title", siteUrl: "https://myanimelist.net/manga/1" });
  mocks.animeLookup.mockResolvedValue({ mainTitle: "Anime 1", siteUrl: "https://anilist.co/anime/1" });
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ onConflictDoNothing: mocks.conflict });
  mocks.conflict.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id: 1 }]);
});
afterEach(() => { vi.useRealTimers(); });

describe("permanent calendar panels", () => {
  it.each([false, true])("offers four categories with no collectors or disabled buttons (adult=%s)", (adult) => {
    const panel = buildCalendarPanel(adult, adult ? "todos" : "hoje");
    const row = panel.components[0].toJSON();
    expect(row.components.map((button) => button.label)).toEqual(["Anime", "Manhwa", "Manga", "Visual Novel"]);
    for (const button of row.components) {
      expect(button.disabled).not.toBe(true);
      expect(parseCalendarCustomId(button.custom_id!)).toMatchObject({ adult, action: "open" });
      expect(button.custom_id!.length).toBeLessThanOrEqual(100);
    }
  });

  it("posts the normal panel immediately without fetching providers", async () => {
    const reply = vi.fn();
    await normalCommand({ options: { getString: () => null }, reply } as never);
    expect(reply).toHaveBeenCalledOnce();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("rejects an adult panel outside NSFW and registers the slash command as NSFW", async () => {
    const reply = vi.fn();
    await adultCommand({ guildId: "guild", channel: { nsfw: false }, reply } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(adultDefinition.toJSON().nsfw).toBe(true);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("publishes the adult panel with its highlighted category, without fetching", async () => {
    const reply = vi.fn();
    await adultCommand({
      guildId: "guild", channel: { nsfw: true }, reply,
      options: { getString: (name: string) => name === "aba" ? "vn" : null },
    } as never);
    const payload = reply.mock.calls[0][0];
    expect(payload.components[0].toJSON().components[3].style).toBe(1);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("acknowledges privately before loading and never edits the shared panel", async () => {
    const click = interaction();
    mocks.load.mockImplementation(async () => {
      expect(click.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      return entries;
    });
    expect(await handleCalendarComponent(asButton(click))).toBe(true);
    expect(click.deferUpdate).not.toHaveBeenCalled();
    expect(click.editReply).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledWith(false, "anime", "hoje");
  });

  it("lets different users use the same panel independently", async () => {
    const first = interaction();
    const second = interaction(calendarCustomId({ ...state, tab: "vn" }));
    second.user.id = "another-person";
    await Promise.all([handleCalendarComponent(asButton(first)), handleCalendarComponent(asButton(second))]);
    expect(first.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(second.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(first.editReply).toHaveBeenCalledOnce();
    expect(second.editReply).toHaveBeenCalledOnce();
    expect(first.editReply.mock.calls[0][0]).not.toEqual(second.editReply.mock.calls[0][0]);
  });

  it("works after days and a module reload with only the custom ID", async () => {
    const id = calendarCustomId(state);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    vi.resetModules();
    const reloaded = await import("../calendar-panel.js");
    const click = interaction(id);
    await reloaded.handleCalendarComponent(asButton(click));
    expect(click.editReply).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledWith(false, "anime", "hoje");
  });

  it("rechecks the NSFW channel on adult clicks and permits NSFW threads", async () => {
    const id = calendarCustomId({ ...state, adult: true });
    const denied = interaction(id);
    await handleCalendarComponent(asButton(denied));
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(mocks.load).not.toHaveBeenCalled();
    const allowed = interaction(id, false, true);
    await handleCalendarComponent(asButton(allowed));
    expect(mocks.load).toHaveBeenCalledWith(true, "anime", "hoje");
    expect(isAdultCalendarChannel({
      guildId: "guild", channel: { isThread: () => true, parent: { nsfw: true } },
    } as never)).toBe(true);
    expect(isAdultCalendarChannel({ guildId: null, channel: { nsfw: true } } as never)).toBe(false);
  });

  it("updates only the private result when paginating and clamps stale pages", async () => {
    const opened = interaction();
    await handleCalendarComponent(asButton(opened));
    const click = interaction(calendarCustomId({ ...state, page: 99, action: "page" }));
    click.message.id = opened.message.id;
    await handleCalendarComponent(asButton(click));
    expect(click.deferUpdate).toHaveBeenCalledOnce();
    expect(click.deferReply).not.toHaveBeenCalled();
    expect(click.editReply.mock.calls[0][0].embeds[0].toJSON().footer?.text).toContain("Página 3/3");
  });

  it("preserves all 74 results and eight pages without refetching or changing source", async () => {
    const original = Array.from({ length: 74 }, (_, index) => ({
      ...entries[index % entries.length], id: String(index + 1), title: `Anime ${index + 1}`,
    }));
    mocks.load.mockResolvedValueOnce(original);
    const opened = interaction();
    await handleCalendarComponent(asButton(opened));
    mocks.load.mockResolvedValue(original.slice(0, 17).map((entry) => ({ ...entry, source: "tenrai" })));
    for (const page of [1, 7, 0]) {
      const click = interaction(calendarCustomId({ ...state, page, action: "page" }));
      click.message.id = opened.message.id;
      await handleCalendarComponent(asButton(click));
      const embed = click.editReply.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.footer?.text).toContain(`Página ${page + 1}/8 • 74 resultado(s)`);
      expect(embed.footer?.text).toContain("AniList");
      expect(embed.footer?.text).not.toContain("Tenrai");
    }
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("does not reuse another user's private consultation", async () => {
    const opened = interaction();
    await handleCalendarComponent(asButton(opened));
    const click = interaction(calendarCustomId({ ...state, page: 1, action: "page" }));
    click.message.id = opened.message.id;
    click.user.id = "another-user";
    await handleCalendarComponent(asButton(click));
    expect(click.editReply).not.toHaveBeenCalled();
    expect(click.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("expires private snapshots explicitly without replacing the page or expiring the public panel", async () => {
    vi.useFakeTimers();
    const opened = interaction();
    await handleCalendarComponent(asButton(opened));
    vi.advanceTimersByTime(31 * 60_000);
    const click = interaction(calendarCustomId({ ...state, page: 1, action: "page" }));
    click.message.id = opened.message.id;
    await handleCalendarComponent(asButton(click));
    expect(click.editReply).not.toHaveBeenCalled();
    expect(click.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("nova lista"), ephemeral: true,
    }));
    const reopened = interaction();
    await handleCalendarComponent(asButton(reopened));
    expect(reopened.editReply).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("identifies the real provider and the fallback's limited weekly coverage", () => {
    const result = buildCalendarResults({ ...state, period: "mes" }, [{
      ...entries[0], source: "tenrai",
    }]);
    const embed = result.embeds[0].toJSON();
    expect(embed.description).toContain("Este mês");
    expect(embed.description).toContain("não a agenda completa");
    expect(embed.footer?.text).toContain("Tenrai");
    expect(embed.footer?.text).not.toContain("AniList");
  });
  it("credits the dated alternative, explains coverage, and offers only compatible subscriptions", () => {
    const result = buildCalendarResults({ ...state, period: "mes" }, [
      { ...entries[0], source: "animeschedule", subscription: { source: "tenrai", id: "55" } },
      { ...entries[1], source: "animeschedule" },
    ]);
    const embed = result.embeds[0].toJSON();
    expect(embed.footer?.text).toContain("AnimeSchedule.net via Asunatracks");
    expect(embed.description).toContain("cobertura pode ser menor");
    const menu = result.components.at(-1)!.toJSON().components[0];
    expect(menu.type).toBe(ComponentType.StringSelect);
    if (menu.type === ComponentType.StringSelect) {
      expect(menu.options.map((option) => option.value)).toEqual(["tenrai:55"]);
    }
  });
  it("shows the original cache timestamp when a provider refresh fails", () => {
    const result = buildCalendarResults(state, [{
      ...entries[0], cachedAt: Date.parse("2026-10-05T12:00:00Z"),
    }]);
    expect(result.embeds[0].toJSON().description).toContain("Agenda em cache de 05/10, 09:00");
  });

  it.each([false, true])("uses unique component IDs on every result page (adult=%s)", (adult) => {
    for (const tab of ["anime", "manhwa", "manga", "vn"] as const) {
      for (const page of [0, 1, 2]) {
        const result = buildCalendarResults({ ...state, adult, tab, page }, entries);
        const components = result.components.flatMap((row) => row.toJSON().components);
        const ids = components.flatMap((component) =>
          "custom_id" in component ? [component.custom_id!] : []);
        // Discord requires uniqueness even for disabled buttons.
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.length <= 100)).toBe(true);
        for (const component of components) {
          if (component.type === ComponentType.Button && !component.disabled) {
            expect(parseCalendarCustomId(component.custom_id!)).not.toBeNull();
          }
        }
      }
    }
  });

  it("keeps the panel usable after errors and distinguishes failure from empty results", async () => {
    mocks.load.mockRejectedValueOnce(new Error("provider unavailable"));
    const failed = interaction();
    await handleCalendarComponent(asButton(failed));
    expect(failed.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Tente novamente") }));
    mocks.load.mockResolvedValueOnce([]);
    const empty = interaction();
    await handleCalendarComponent(asButton(empty));
    expect(empty.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain("Nenhum resultado");
  });

  it("does not replace a private page when a page refresh fails", async () => {
    mocks.load.mockRejectedValueOnce(new Error("provider unavailable"));
    const click = interaction(calendarCustomId({ ...state, action: "page" }));
    await handleCalendarComponent(asButton(click));
    expect(click.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(click.editReply).not.toHaveBeenCalled();
  });

  it.each(["calendar:v1:normal:anime:todos:0:open", "calendar:v1:adult:vn:hoje:1000:page", "calendar:v1:adult:invalid:hoje:0:open"])(
    "rejects malformed or out-of-range IDs: %s", (id) => expect(parseCalendarCustomId(id)).toBeNull(),
  );
  it("ignores buttons owned by other features", async () => {
    expect(await handleCalendarComponent(asButton(interaction("season_page_next_1")))).toBe(false);
  });

  it("deduplicates subscription options for multiple episodes and omits unsupported VN subscriptions", () => {
    const duplicates = buildCalendarResults(state, [entries[0], entries[0]]);
    const menu = duplicates.components.at(-1)!.toJSON().components[0];
    expect(menu.type).toBe(ComponentType.StringSelect);
    if (menu.type === ComponentType.StringSelect) expect(menu.options).toHaveLength(1);
    const vn = buildCalendarResults({ ...state, tab: "vn" }, entries);
    expect(vn.components.flatMap((row) => row.toJSON().components).some((component) =>
      component.type === ComponentType.StringSelect)).toBe(false);
  });

  it("fits long results within Discord embed limits without hiding select options", () => {
    const long = entries.map((entry) => ({
      ...entry, title: "A".repeat(200), siteUrl: `https://example.com/${"x".repeat(500)}`,
      details: "B".repeat(400),
    }));
    const result = buildCalendarResults(state, long);
    expect(result.embeds[0].toJSON().description!.length).toBeLessThanOrEqual(4096);
  });

  it.each([false, true])("subscribes from the menu with the correct source and adult flag (%s)", async (adult) => {
    const subscriptionState = { ...state, adult, tab: "manhwa" as const, action: "subscribe" as const };
    const result = buildCalendarResults(subscriptionState, [{
      id: "1", source: "tenrai", title: "Title", siteUrl: "https://myanimelist.net/manga/1", details: "Em lançamento",
    }]);
    const click = interaction(calendarCustomId(subscriptionState), true, adult);
    click.values = ["tenrai:1"];
    click.message.components = result.components.map((row) => {
      const json = row.toJSON();
      return { components: json.components.map((component) => ({
        ...component, customId: "custom_id" in component ? component.custom_id : undefined,
      })) };
    });
    await handleCalendarComponent(click as unknown as StringSelectMenuInteraction);
    expect(mocks.lookup).toHaveBeenCalledWith("tenrai", "1");
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      source: "tenrai", manhwaId: "1", adult, tipo: "manhwa", discordUserId: "person",
    }));
    expect(mocks.conflict).toHaveBeenCalledOnce();
  });

  it("does not write subscriptions for a selection absent from the message", async () => {
    const click = interaction(calendarCustomId({ ...state, action: "subscribe" }), true);
    await handleCalendarComponent(click as unknown as StringSelectMenuInteraction);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
