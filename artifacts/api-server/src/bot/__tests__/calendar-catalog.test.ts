import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearCalendarCatalogCache, fetchCalendarAnimeCatalog } from "../calendar-catalog.js";
const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ logger: { warn: mocks.warn } }));
const request = vi.fn();
const anime = (id: number) => ({ mal_id: id, title: `Anime ${id}`, genres: [{ name: "Action" }] });
function response(items: unknown[], page = 1, next = false) {
  return { ok: true, json: async () => ({
    data: items, pagination: { current_page: page, has_next_page: next },
  }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  clearCalendarCatalogCache();
  vi.stubGlobal("fetch", request);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("expanded calendar identification catalog", () => {
  it("does not erase known duration with missing duration from the overlapping endpoint", async () => {
    request.mockImplementation(async (url: string) => response([{
      ...anime(1), duration: new URL(url).pathname.endsWith("seasons/now") ? "53 sec" : null,
    }]));
    expect((await fetchCalendarAnimeCatalog())[0].duration).toBe("53 sec");
  });
  it("follows season and airing pages, including older ongoing shows, without duplicate IDs", async () => {
    request.mockImplementation(async (url: string) => {
      const parsed = new URL(url), page = Number(parsed.searchParams.get("page"));
      expect(parsed.searchParams.get("limit")).toBe("50");
      if (parsed.pathname.endsWith("seasons/now")) return response([anime(page)], page, page < 3);
      expect(parsed.searchParams.get("status")).toBe("airing");
      return response([anime(page === 1 ? 1 : 99)], page, page < 2);
    });
    const catalog = await fetchCalendarAnimeCatalog();
    expect(catalog.map((entry) => entry.mal_id)).toEqual([1, 2, 3, 99]);
    expect(request).toHaveBeenCalledTimes(5);
  });
  it("shares in-flight pages and caches metadata across calendar filters and periods", async () => {
    request.mockResolvedValue(response([anime(1)]));
    await Promise.all([fetchCalendarAnimeCatalog(), fetchCalendarAnimeCatalog()]);
    await fetchCalendarAnimeCatalog();
    expect(request).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    await fetchCalendarAnimeCatalog();
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("preserves verified first pages when a later page fails, then resumes without redownloading them", async () => {
    let fail = true;
    request.mockImplementation(async (url: string) => {
      const parsed = new URL(url), page = Number(parsed.searchParams.get("page"));
      if (!parsed.pathname.endsWith("seasons/now")) return response([anime(99)]);
      if (page === 2 && fail) return { ok: false, status: 503 };
      return response([anime(page)], page, page === 1);
    });
    expect((await fetchCalendarAnimeCatalog()).map((entry) => entry.mal_id)).toEqual([1, 99]);
    expect(mocks.warn).toHaveBeenCalled();
    fail = false;
    vi.advanceTimersByTime(30_001);
    expect((await fetchCalendarAnimeCatalog()).map((entry) => entry.mal_id)).toEqual([1, 2, 99]);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("keeps a working catalog when the other endpoint is unavailable", async () => {
    request.mockImplementation(async (url: string) => new URL(url).pathname.endsWith("seasons/now")
      ? { ok: false, status: 503 } : response([anime(99)]));
    expect((await fetchCalendarAnimeCatalog())[0].mal_id).toBe(99);
  });
  it("fails explicitly when both metadata sources fail or have invalid pagination", async () => {
    request.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchCalendarAnimeCatalog()).rejects.toThrow("indisponível");
    clearCalendarCatalogCache();
    request.mockResolvedValue({ ok: true, json: async () => ({ data: [anime(1)] }) });
    await expect(fetchCalendarAnimeCatalog()).rejects.toThrow("indisponível");
  });
  it("rejects a repeated provider page and bounds infinite pagination", async () => {
    request.mockImplementation(async () => response([anime(1)], 1, true));
    expect((await fetchCalendarAnimeCatalog()).map((entry) => entry.mal_id)).toEqual([1]);
    expect(request).toHaveBeenCalledTimes(4);
    clearCalendarCatalogCache(); request.mockClear();
    request.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return response([anime(page)], page, true);
    });
    expect(await fetchCalendarAnimeCatalog()).toHaveLength(15);
    expect(request).toHaveBeenCalledTimes(30);
  });
  it("merges aliases and preserves adult classification when overlapping catalogs disagree", async () => {
    request.mockImplementation(async (url: string) => response([{
      ...anime(1), title: new URL(url).pathname.endsWith("seasons/now") ? "Season title" : "Airing title",
      genres: [{ name: new URL(url).pathname.endsWith("seasons/now") ? "Hentai" : "Action" }],
      rating: new URL(url).pathname.endsWith("seasons/now") ? "Rx - Hentai" : "PG-13",
    }, { ...anime(2), mal_id: -1 }]));
    const catalog = await fetchCalendarAnimeCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].calendarTitles).toEqual(["Season title", "Airing title"]);
    expect(catalog[0].genres).toContainEqual({ name: "Hentai" });
    expect(catalog[0].rating).toBe("Rx - Hentai");
  });
  it("reuses last-good metadata on failed refreshes but never indefinitely", async () => {
    request.mockResolvedValue(response([anime(1)]));
    await fetchCalendarAnimeCatalog();
    request.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(await fetchCalendarAnimeCatalog()).toHaveLength(1);
    vi.advanceTimersByTime(6 * 60 * 60_000 + 1);
    await expect(fetchCalendarAnimeCatalog()).rejects.toThrow("indisponível");
  });
  it("honors provider cooldowns without re-fetching failed pages on every click", async () => {
    request.mockResolvedValue({
      ok: false, status: 429, headers: { get: (key: string) => key === "retry-after" ? "120" : null },
    });
    await expect(fetchCalendarAnimeCatalog()).rejects.toThrow("indisponível");
    const calls = request.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    await expect(fetchCalendarAnimeCatalog()).rejects.toThrow("indisponível");
    expect(request).toHaveBeenCalledTimes(calls);
    vi.advanceTimersByTime(60_001);
    request.mockResolvedValue(response([anime(1)]));
    expect(await fetchCalendarAnimeCatalog()).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(calls + 2);
  });
});
