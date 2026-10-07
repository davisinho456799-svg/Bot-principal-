import { describe, expect, it, vi } from "vitest";
import { animeNotificationSource, fetchReleasedAnimeEpisodes, type EpisodePage } from "../anime-episode-monitor";

const now = Date.parse("2026-10-07T12:00:00Z");
const past = "2026-10-06T12:00:00Z";
const future = "2026-10-08T12:00:00Z";
const page = (rows: EpisodePage["data"], last = 1, next = false): EpisodePage => ({
  data: rows, pagination: { last_visible_page: last, has_next_page: next },
});
const deps = () => ({
  now: () => now,
  metadata: vi.fn(async () => ({ status: "RELEASING", episodes: 12 })),
  episodePage: vi.fn(async (_id: number, _page: number) => page([{ mal_id: 3, aired: past }])),
});
function aniList(status: string, episodes: number | null, rows: unknown[] = []) {
  return vi.fn(async () => new Response(JSON.stringify({
    data: { Media: { status, episodes }, Page: { airingSchedules: rows } },
  }))) as unknown as typeof fetch;
}

describe("anime lookup category without changing stored identities", () => {
  it.each(["jikan", "tenrai"])("uses MAL anime episodes for %s anime subscriptions", source => {
    expect(animeNotificationSource(source, "anime")).toBe("jikan-anime");
    expect(animeNotificationSource(source, "manga")).toBe(source);
    expect(animeNotificationSource(source, "manhwa")).toBe(source);
  });
  it("recognizes anime favorites from a canonical MAL URL", () => {
    expect(animeNotificationSource("jikan", null, "https://myanimelist.net/anime/21/One_Piece")).toBe("jikan-anime");
    expect(animeNotificationSource("tenrai", undefined, "https://myanimelist.net/anime/21")).toBe("jikan-anime");
  });
  it.each(["https://myanimelist.net/manga/21", "https://example.com/anime/21", "invalid"])(
    "does not guess anime from %s", url => {
      expect(animeNotificationSource("jikan", null, url)).toBe("jikan");
    },
  );
  it("preserves explicit manga classification and already typed sources", () => {
    expect(animeNotificationSource("jikan", "manga", "https://myanimelist.net/anime/21")).toBe("jikan");
    expect(animeNotificationSource("anilist-anime", "anime")).toBe("anilist-anime");
    expect(animeNotificationSource("anilist", "manhwa")).toBe("anilist");
  });
});

describe("AniList released episodes", () => {
  it("uses a past broadcast, not the announced season total", async () => {
    const request = aniList("RELEASING", 12, [{ episode: 3, airingAt: now / 1000 - 60 }]);
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", { ...deps(), request }))
      .toEqual({ value: 3, isProxy: false });
    const body = JSON.parse((vi.mocked(request).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables).toEqual({ id: 21, before: now / 1000 + 1 });
    expect(body.query).toContain("airingAt_lesser");
    expect(body.query).toContain("sort: EPISODE_DESC");
  });
  it("rejects a future broadcast even if supplied by the provider", async () => {
    const request = aniList("RELEASING", 12, [{ episode: 4, airingAt: now / 1000 + 60 }]);
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", { ...deps(), request }))
      .toMatchObject({ _err: true, kind: "no_data" });
  });
  it("accepts an episode at the current broadcast time", async () => {
    const request = aniList("RELEASING", null, [{ episode: 4, airingAt: now / 1000 }]);
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", { ...deps(), request }))
      .toEqual({ value: 4, isProxy: false });
  });
  it.each(["RELEASING", "HIATUS", "CANCELLED"])("does not use a planned total in %s", async status => {
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", {
      ...deps(), request: aniList(status, 12),
    })).toMatchObject({ _err: true, kind: "no_data" });
  });
  it("uses a finished total only for a finished anime", async () => {
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", {
      ...deps(), request: aniList("FINISHED", 12),
    })).toEqual({ value: 12, isProxy: false });
  });
  it("returns zero for an anime not yet released", async () => {
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", {
      ...deps(), request: aniList("NOT_YET_RELEASED", 12),
    })).toEqual({ value: 0, isProxy: false });
  });
  it("preserves rate-limit diagnostics rather than synthesizing a count", async () => {
    const request = vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", { ...deps(), request }))
      .toMatchObject({ _err: true, kind: "http_429", httpStatus: 429 });
  });
  it("rejects GraphQL partial errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: { Media: { status: "FINISHED", episodes: 12 } }, errors: [{ message: "failed" }],
    }))) as unknown as typeof fetch;
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", { ...deps(), request }))
      .toMatchObject({ _err: true, kind: "invalid_response" });
  });
  it.each([NaN, 0, -1, 2.5])("ignores an invalid episode number %s", async episode => {
    expect(await fetchReleasedAnimeEpisodes("21", "anilist-anime", {
      ...deps(), request: aniList("RELEASING", 12, [{ episode, airingAt: now / 1000 - 60 }]),
    })).toMatchObject({ _err: true, kind: "no_data" });
  });
});

describe("MAL/Tenrai dated episode records", () => {
  it("counts dated releases, not the season total; skips null and future dates", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockResolvedValue(page([
      { mal_id: 3, aired: past }, { mal_id: 4, aired: future }, { mal_id: 5, aired: null },
    ]));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toEqual({ value: 3, isProxy: false });
  });
  it("consults the last page for long-running anime", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockImplementation(async (_id, number) =>
      number === 1 ? page([{ mal_id: 100, aired: past }], 12, true)
        : page([{ mal_id: 1180, aired: past }, { mal_id: 1181, aired: future }], 12));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toEqual({ value: 1180, isProxy: false });
    expect(dependencies.episodePage.mock.calls).toEqual([[21, 1], [21, 12]]);
  });
  it("checks previous pages when the last page is only future records", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockImplementation(async (_id, number) =>
      number === 1 ? page([], 3, true) : number === 3
        ? page([{ mal_id: 201, aired: future }], 3)
        : page([{ mal_id: 200, aired: past }], 3, true));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toEqual({ value: 200, isProxy: false });
    expect(dependencies.episodePage.mock.calls).toEqual([[21, 1], [21, 3], [21, 2]]);
  });
  it("returns no data when releases cannot be verified", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockResolvedValue(page([{ mal_id: 3, aired: "invalid" }]));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toMatchObject({ _err: true, kind: "no_data" });
  });
  it("does not request episode lists for unreleased/finished anime", async () => {
    for (const [status, count] of [["NOT_YET_RELEASED", 0], ["FINISHED", 12]] as const) {
      const dependencies = deps();
      dependencies.metadata.mockResolvedValue({ status, episodes: 12 });
      expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
        .toEqual({ value: count, isProxy: false });
      expect(dependencies.episodePage).not.toHaveBeenCalled();
    }
  });
  it("bounds pagination when dates are unavailable", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockImplementation(async (_id, number) => page([], 999, number === 1));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toMatchObject({ _err: true, kind: "no_data" });
    expect(dependencies.episodePage).toHaveBeenCalledTimes(10);
  });
  it("rejects broken pagination and preserves timeouts", async () => {
    const dependencies = deps();
    dependencies.episodePage.mockResolvedValue(page([], 1, true));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toMatchObject({ _err: true, kind: "invalid_response" });
    dependencies.episodePage.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    expect(await fetchReleasedAnimeEpisodes("21", "jikan-anime", dependencies))
      .toMatchObject({ _err: true, kind: "timeout" });
  });
  it.each(["0", "-1", "21junk", "Infinity"])("rejects invalid IDs %s before contacting providers", async id => {
    const dependencies = deps();
    expect(await fetchReleasedAnimeEpisodes(id, "jikan-anime", dependencies))
      .toMatchObject({ _err: true, kind: "invalid_response" });
    expect(dependencies.metadata).not.toHaveBeenCalled();
  });
});
