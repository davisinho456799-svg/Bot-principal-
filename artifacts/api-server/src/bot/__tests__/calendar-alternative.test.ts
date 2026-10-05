import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearAlternativeCalendarCache, fetchAlternativeCalendar } from "../calendar-alternative.js";

const mocks = vi.hoisted(() => ({ metadata: vi.fn() }));
vi.mock("../tenrai-fallback.js", () => ({
  genresOfTenrai: (item: { genres?: { name: string }[] }) => (item.genres ?? []).map((genre) => genre.name),
}));
vi.mock("../calendar-catalog.js", async (original) => ({
  ...await original<typeof import("../calendar-catalog.js")>(),
  fetchCalendarAnimeCatalog: mocks.metadata,
}));
const request = vi.fn();
const range = { start: Date.parse("2026-10-05T03:00:00Z") / 1000, end: Date.parse("2026-11-01T03:00:00Z") / 1000 - 1 };
const item = {
  id: "normal-anime", title: "Normal Anime", episode_number: 2,
  episode_date: "2026-10-06T12:00:00-03:00", external_ids: { mal: 10 },
};
function response(url: string, rows: unknown[]) {
  const params = new URL(url).searchParams;
  return { ok: true, json: async () => ({
    configured: true, stale: false, filters: {
      year: Number(params.get("year")), week: Number(params.get("week")), air_type: "raw",
    }, items: rows,
  }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  clearAlternativeCalendarCache();
  vi.stubGlobal("fetch", request);
  mocks.metadata.mockResolvedValue([
    { mal_id: 10, title: "Normal Anime", genres: [{ name: "Action" }] },
    { mal_id: 11, title: "Adult Anime", genres: [{ name: "Hentai" }] },
  ]);
  request.mockImplementation(async (url: string) => response(url, [item]));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("dated AnimeSchedule/Asunatracks alternative", () => {
  it("loads every remaining ISO week and keeps actual dated episodes and MAL subscriptions", async () => {
    request.mockImplementation(async (url: string) => {
      const week = new URL(url).searchParams.get("week");
      return response(url, [{ ...item, episode_date: week === "44" ? "2026-10-31T12:00:00-03:00" : item.episode_date }]);
    });
    const rows = await fetchAlternativeCalendar(false, range);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(([url]) => new URL(url).searchParams.get("week"))).toEqual(["41", "42", "43", "44"]);
    expect(rows.at(-1)).toMatchObject({
      source: "animeschedule", subscription: { source: "tenrai", id: "10" },
    });
    expect(rows.at(-1)!.details).toContain("31/10");
  });
  it.each([false, true])("keeps normal and adult classifications separate (%s)", async (adult) => {
    request.mockImplementation(async (url: string) => response(url, [
      item, { ...item, id: "adult-anime", title: "Adult Anime", external_ids: { mal: 11 } },
      { ...item, id: "unknown", title: "Unknown", external_ids: {} },
    ]));
    const rows = await fetchAlternativeCalendar(adult, range);
    expect(rows.every((entry) => entry.id === (adult ? "adult-anime" : "normal-anime"))).toBe(true);
  });
  it("requires unique exact title matches when an external ID is unavailable", async () => {
    request.mockImplementation(async (url: string) => response(url, [
      { ...item, external_ids: {}, title: "Normal-Anime" },
      { ...item, external_ids: {}, title: "Normal Anime Season 2" },
    ]));
    expect((await fetchAlternativeCalendar(false, range)).every((entry) => entry.title === "Normal-Anime")).toBe(true);
    mocks.metadata.mockResolvedValue([
      { mal_id: 10, title: "Normal Anime", genres: [{ name: "Action" }] },
      { mal_id: 12, title: "Normal Anime", genres: [{ name: "Action" }] },
    ]);
    await expect(fetchAlternativeCalendar(false, range)).rejects.toThrow("identificadas");
  });
  it("excludes out-of-range dates, unknown ratings, missing dates, and unconfirmed delays", async () => {
    mocks.metadata.mockResolvedValue([
      { mal_id: 10, title: "Normal Anime", genres: [{ name: "Action" }] },
      { mal_id: 12, title: "No Rating", genres: [] },
    ]);
    request.mockImplementation(async (url: string) => response(url, [
      item, { ...item, episode_date: "2026-11-01T00:00:00-03:00" },
      { ...item, episode_date: "2026-10-06" },
      { ...item, is_on_break: true, delayed_until: "0001-01-01T00:00:00Z" },
      { ...item, external_ids: { mal: 12 } },
    ]));
    const rows = await fetchAlternativeCalendar(false, range);
    expect(rows.every((entry) => entry.timestamp === Date.parse(item.episode_date) / 1000)).toBe(true);
    expect(rows).toHaveLength(4);
  });
  it("respects explicit delayed dates instead of the original broadcast date", async () => {
    request.mockImplementation(async (url: string) => response(url, [{
      ...item, is_on_break: true, delayed_until: "2026-10-25T10:00:00-03:00",
    }]));
    expect((await fetchAlternativeCalendar(false, range))[0].details).toContain("25/10");
  });
  it("rejects partial calendars when a week fails, unconfigured feeds and stale responses", async () => {
    request.mockImplementation(async (url: string) =>
      new URL(url).searchParams.get("week") === "42" ? { ok: false, status: 503 } : response(url, [item]));
    await expect(fetchAlternativeCalendar(false, range)).rejects.toThrow("HTTP 503");
    clearAlternativeCalendarCache();
    request.mockResolvedValue({ ok: true, json: async () => ({ configured: false, items: [] }) });
    await expect(fetchAlternativeCalendar(false, range)).rejects.toThrow("invalid");
    clearAlternativeCalendarCache();
    request.mockImplementation(async (url: string) => {
      const result = response(url, [item]);
      return { ...result, json: async () => ({ ...await result.json(), stale: true }) };
    });
    await expect(fetchAlternativeCalendar(false, range)).rejects.toThrow("stale");
  });
  it("handles ISO week/year rollover without dropping the end of December", async () => {
    const december = { start: Date.parse("2026-12-28T03:00:00Z") / 1000, end: Date.parse("2027-01-01T03:00:00Z") / 1000 - 1 };
    request.mockImplementation(async (url: string) => response(url, [{ ...item, episode_date: "2026-12-31T10:00:00-03:00" }]));
    const rows = await fetchAlternativeCalendar(false, december);
    expect(rows[0].details).toContain("31/12");
    const params = new URL(request.mock.calls[0][0]).searchParams;
    expect(params.get("year")).toBe("2026");
    expect(params.get("week")).toBe("53");
  });
  it("uses official alternate names but never guesses a different season or ambiguous work", async () => {
    mocks.metadata.mockResolvedValue([{
      mal_id: 10, title: "Original Name", title_synonyms: ["Normal Anime"],
      title_japanese: "通常のアニメ", titles: [{ title: "English Name" }],
      genres: [{ name: "Action" }],
    }]);
    request.mockImplementation(async (url: string) => response(url, [{
      ...item, title: "Normal Anime", external_ids: {},
    }]));
    expect((await fetchAlternativeCalendar(false, range))[0].subscription?.id).toBe("10");
  });
  it("shares weekly schedules between simultaneous normal and adult consultations", async () => {
    request.mockImplementation(async (url: string) => response(url, [
      item, { ...item, id: "adult", external_ids: { mal: 11 } },
    ]));
    const [normal, adult] = await Promise.all([
      fetchAlternativeCalendar(false, range), fetchAlternativeCalendar(true, range),
    ]);
    expect(normal.every((entry) => entry.subscription?.id === "10")).toBe(true);
    expect(adult.every((entry) => entry.subscription?.id === "11")).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("excludes conflicting IDs and honors an explicit adult rating even without genres", async () => {
    mocks.metadata.mockResolvedValue([
      { mal_id: 10, title: "Normal Anime", genres: [{ name: "Action" }] },
      { mal_id: 11, title: "Adult Anime", rating: "Rx - Hentai" },
    ]);
    request.mockImplementation(async (url: string) => response(url, [
      item, { ...item, external_ids: { mal: 11 }, mal_id: 10 },
      { ...item, id: "adult", external_ids: { mal: 11 } },
    ]));
    const normal = await fetchAlternativeCalendar(false, range);
    const adult = await fetchAlternativeCalendar(true, range);
    expect(normal.every((entry) => entry.subscription?.id === "10")).toBe(true);
    expect(adult.every((entry) => entry.id === "adult")).toBe(true);
  });
});
