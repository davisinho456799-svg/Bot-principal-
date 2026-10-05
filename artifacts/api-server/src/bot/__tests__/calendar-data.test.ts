import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarRange, loadCalendarEntries } from "../calendar-data.js";
const mocks = vi.hoisted(() => ({
  anime: vi.fn(), comics: vi.fn(), vn: vi.fn(),
}));
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
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  mocks.anime.mockResolvedValue([]);
  mocks.comics.mockResolvedValue([]);
  mocks.vn.mockResolvedValue([]);
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
      expect(variables.start).toBe(start - 1);
      expect(variables.end).toBe(calendarRange("mes").end + 1);
      const offset = (variables.page - 1) * 25;
      return response("airingSchedules", Array.from({ length: 25 }, (_, index) => ({
        airingAt: start + (offset + index) * 4 * 3600,
        episode: offset + index + 1, media,
      })), variables.page < 5);
    });
    const rows = await loadCalendarEntries(false, "anime", "mes");
    expect(rows).toHaveLength(125);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(rows.at(-1)!.details).toContain("25/10");
    expect(mocks.anime).not.toHaveBeenCalled();
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
