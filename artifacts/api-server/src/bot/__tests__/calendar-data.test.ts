import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarRange, clearCalendarCache, loadCalendarEntries } from "../calendar-data.js";
const mocks = vi.hoisted(() => ({
  anime: vi.fn(), comics: vi.fn(), vn: vi.fn(), alternative: vi.fn(), warn: vi.fn(),
}));
vi.mock("../calendar-alternative.js", () => ({ fetchAlternativeCalendar: mocks.alternative }));
vi.mock("../../lib/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../vndb.js", () => ({ fetchVNDBCalendar: mocks.vn }));
vi.mock("../tenrai-fallback.js", () => ({
  fetchTenraiSeasonAnime: mocks.anime, fetchTenraiPublishingManga: mocks.comics,
  genresOfTenrai: (item: { genres: { name: string }[] }) => item.genres.map((genre) => genre.name),
  nextTenraiBroadcast: () => 1791212400,
  titleOfTenrai: (item: { title: string }) => item.title,
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  clearCalendarCache();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  mocks.anime.mockResolvedValue([]);
  mocks.comics.mockResolvedValue([]);
  mocks.vn.mockResolvedValue([]);
  mocks.alternative.mockRejectedValue(new Error("Alternate source unavailable"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function response(field: string, rows: unknown[], hasNextPage = false) {
  return { ok: true, json: async () => ({ data: { Page: { [field]: rows, pageInfo: { hasNextPage } } } }) };
}
const media = {
  id: 123, title: { romaji: "Title", english: null }, genres: ["Action"],
  siteUrl: "https://anilist.co/manga/123", updatedAt: 1791212400, isAdult: false,
};
describe("calendar data and relative dates", () => {
  it("uses Brasília's date rather than tomorrow's UTC date", () => {
    const range = calendarRange("hoje", new Date("2026-10-06T01:00:00Z"));
    expect(new Date(range.start * 1000).toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(new Date(range.end * 1000).toISOString()).toBe("2026-10-06T02:59:59.000Z");
  });
  it("uses tomorrow only, and computes seven-day and month ranges", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(calendarRange("amanha", now).start - calendarRange("hoje", now).start).toBe(86400);
    expect(calendarRange("semana", now).end - calendarRange("semana", now).start).toBe(7 * 86400 - 1);
    expect(new Date(calendarRange("mes", now).end * 1000).toISOString()).toBe("2026-11-01T02:59:59.000Z");
  });
  it.each(["manga", "manhwa"] as const)("requests the correct country and safe filter for %s", async (tab) => {
    fetchMock.mockResolvedValue(response("media", [media]));
    const result = await loadCalendarEntries(false, tab, "hoje");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toMatchObject({ country: tab === "manga" ? "JP" : "KR", adult: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "anilist", id: "123" });
    expect(mocks.comics).not.toHaveBeenCalled();
  });
  it("excludes adult anime and sorts episodes by broadcast time", async () => {
    fetchMock.mockResolvedValue(response("airingSchedules", [
      { airingAt: 1791212400, episode: 1, media: { ...media, isAdult: true } },
      { airingAt: 1791212401, episode: 2, media },
    ]));
    const rows = await loadCalendarEntries(false, "anime", "hoje");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toContain("Ep 2");
  });
  it("loads the full monthly schedule beyond 75 episodes and October 11", async () => {
    const start = calendarRange("mes").start;
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { variables, query } = JSON.parse(init.body);
      expect(query).toContain("pageInfo { hasNextPage }");
      expect(query).toContain("perPage: 50");
      expect(variables.start).toBe(start - 1);
      expect(variables.end).toBe(calendarRange("mes").end + 1);
      const offset = (variables.page - 1) * 50;
      return response("airingSchedules", Array.from({ length: Math.min(50, 125 - offset) }, (_, index) => ({
        airingAt: start + (offset + index) * 4 * 3600,
        episode: offset + index + 1, media,
      })), variables.page < 3);
    });
    const rows = await loadCalendarEntries(false, "anime", "mes");
    expect(rows).toHaveLength(125);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows.at(-1)!.details).toContain("25/10");
    expect(mocks.anime).not.toHaveBeenCalled();
    expect(mocks.alternative).not.toHaveBeenCalled();
  });
  it("opens the month using the dated alternative when AniList is rate limited", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    const alternative = [{
      id: "anime", source: "animeschedule", title: "Alternative",
      siteUrl: "https://animeschedule.net/anime/anime",
      timestamp: calendarRange("mes").end - 1000, details: "Ep 4 — 31/10, 20:00",
      subscription: { source: "tenrai", id: "55" },
    }];
    mocks.alternative.mockResolvedValue(alternative);
    const results = await Promise.all([
      loadCalendarEntries(false, "anime", "mes"),
      loadCalendarEntries(false, "anime", "mes"),
      loadCalendarEntries(false, "anime", "mes"),
    ]);
    expect(results.every((rows) => rows[0].source === "animeschedule")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.alternative).toHaveBeenCalledOnce();
    await loadCalendarEntries(false, "anime", "mes");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.alternative).toHaveBeenCalledOnce();
  });
  it("shares complete provider pages across simultaneous normal and adult consultations", async () => {
    fetchMock.mockResolvedValue(response("airingSchedules", [
      { media: { ...media, id: 1 }, episode: 1, airingAt: calendarRange("mes").start + 10 },
      { media: { ...media, id: 2, isAdult: true }, episode: 1, airingAt: calendarRange("mes").start + 10 },
    ]));
    const [normal, adult] = await Promise.all([
      loadCalendarEntries(false, "anime", "mes"),
      loadCalendarEntries(true, "anime", "mes"),
    ]);
    expect(normal.map((entry) => entry.id)).toEqual(["1"]);
    expect(adult.map((entry) => entry.id)).toEqual(["2"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("serves the last complete calendar with its original cache time on a failed refresh", async () => {
    fetchMock.mockResolvedValueOnce(response("airingSchedules", [
      { media, episode: 1, airingAt: calendarRange("mes").start + 100 },
    ])).mockRejectedValue(new Error("Provider offline"));
    const original = await loadCalendarEntries(false, "anime", "mes");
    const fetchedAt = Date.now();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const stale = await loadCalendarEntries(false, "anime", "mes");
    expect(stale.map((entry) => entry.id)).toEqual(original.map((entry) => entry.id));
    expect(stale[0].cachedAt).toBe(fetchedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await loadCalendarEntries(false, "anime", "mes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("honors Retry-After across calendar periods without hammering the provider", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: (key: string) => key === "retry-after" ? "120" : null },
    }).mockResolvedValue(response("airingSchedules", []));
    await expect(loadCalendarEntries(false, "anime", "mes")).rejects.toThrow("agenda mensal");
    await loadCalendarEntries(false, "anime", "semana");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(120_001);
    await loadCalendarEntries(false, "anime", "amanha");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("keeps the original HTTP error as the monthly error's cause", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const error = await loadCalendarEntries(false, "anime", "mes").catch((reason) => reason);
    expect(error.cause.message).toContain("HTTP 503");
    expect(error.cause.page).toBe(1);
  });
  it("never exposes a partial AniList schedule when a later page fails", async () => {
    fetchMock.mockResolvedValueOnce(response("airingSchedules", [
      { airingAt: calendarRange("semana").start + 100, episode: 1, media },
    ], true)).mockResolvedValueOnce({ ok: false, status: 429 });
    mocks.anime.mockResolvedValue([{ mal_id: 55, title: "Fallback", genres: [{ name: "Action" }] }]);
    const rows = await loadCalendarEntries(false, "anime", "semana");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("tenrai");
    expect(rows.some((row) => row.source === "anilist-anime")).toBe(false);
  });
  it("keeps a valid empty AniList schedule instead of inventing fallback episodes", async () => {
    fetchMock.mockResolvedValue(response("airingSchedules", []));
    expect(await loadCalendarEntries(false, "anime", "amanha")).toEqual([]);
    expect(mocks.anime).not.toHaveBeenCalled();
  });
  it("does not silently present partially fetched comics as a complete list", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
      JSON.parse(init.body).variables.page === 2
        ? { ok: false, status: 429 } : response("media", [media]));
    mocks.comics.mockResolvedValue([{ mal_id: 55, title: "Fallback", genres: [{ name: "Action" }] }]);
    expect((await loadCalendarEntries(false, "manga", "hoje"))[0].source).toBe("tenrai");
  });
  it("filters tomorrow's adult anime without including today's episodes", async () => {
    fetchMock.mockResolvedValueOnce(response("airingSchedules", [
      { media: { ...media, id: 2, isAdult: true }, episode: 1, airingAt: calendarRange("amanha").start + 100 },
      { media: { ...media, id: 4, isAdult: false }, episode: 1, airingAt: calendarRange("amanha").start + 100 },
    ]));
    expect((await loadCalendarEntries(true, "anime", "amanha")).map((row) => row.id)).toEqual(["2"]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.start).toBe(calendarRange("amanha").start - 1);
    expect(body.variables.end).toBe(calendarRange("amanha").end + 1);
    fetchMock.mockResolvedValue(response("media", [
      { ...media, id: 1, isAdult: true, nextAiringEpisode: { episode: 1, airingAt: calendarRange("hoje").start + 100 } },
      { ...media, id: 2, isAdult: true, nextAiringEpisode: { episode: 1, airingAt: calendarRange("amanha").start + 100 } },
      { ...media, id: 3, isAdult: true, nextAiringEpisode: null },
    ]));
    expect(await loadCalendarEntries(true, "anime", "todos")).toHaveLength(3);
  });
  it.each([false, true])("never substitutes a next-week fallback for a monthly agenda (adult=%s)", async (adult) => {
    fetchMock.mockRejectedValue(new Error("AniList HTTP 429"));
    await expect(loadCalendarEntries(adult, "anime", "mes")).rejects.toThrow("agenda mensal");
    expect(mocks.anime).not.toHaveBeenCalled();
    expect(mocks.alternative).toHaveBeenCalledWith(adult, calendarRange("mes"));
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.any(Error), provider: "AniList",
    }), expect.any(String));
  });
  it("preserves Tenrai IDs and excludes adult fallback comics in the normal calendar", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    mocks.comics.mockResolvedValue([
      { mal_id: 55, title: "Normal", genres: [{ name: "Action" }] },
      { mal_id: 56, title: "Adult", genres: [{ name: "Erotica" }] },
    ]);
    const normal = await loadCalendarEntries(false, "manhwa", "hoje");
    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({ source: "tenrai", id: "55", siteUrl: "https://myanimelist.net/manga/55" });
    const adult = await loadCalendarEntries(true, "manhwa", "todos");
    expect(adult.map((row) => row.id)).toEqual(["56"]);
  });
  it.each([false, true])("fetches only VNDB for visual novels (adult=%s)", async (adult) => {
    mocks.vn.mockResolvedValue([{
      vnId: "v1", mainTitle: "VN", siteUrl: "https://vndb.org/v1", released: "2026-10-01", developers: ["Dev"],
    }]);
    const result = await loadCalendarEntries(adult, "vn", adult ? "todos" : "hoje");
    expect(result[0]).toMatchObject({ source: "vndb", id: "v1" });
    expect(mocks.vn).toHaveBeenCalledWith(adult, 2, 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.anime).not.toHaveBeenCalled();
    expect(mocks.comics).not.toHaveBeenCalled();
  });
  it("propagates failed fallback instead of pretending there are no releases", async () => {
    fetchMock.mockRejectedValue(new Error("AniList unavailable"));
    mocks.comics.mockRejectedValue(new Error("Tenrai unavailable"));
    await expect(loadCalendarEntries(false, "manga", "hoje")).rejects.toThrow("Tenrai unavailable");
  });
});
