import type { AutocompleteInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTitleAutocomplete, respondTitleAutocomplete } from "../title-autocomplete.js";

const uuid = "11111111-1111-1111-1111-111111111111";
const anime = (media = [{ id: 20, title: { english: "Naruto" } }]) =>
  new Response(JSON.stringify({ data: { Page: { media } } }));
const manga = () => new Response(JSON.stringify({
  result: "ok", data: [{ id: uuid, attributes: { title: { en: "One Piece" } } }],
}));

afterEach(() => vi.useRealTimers());

describe("bounded title suggestions", () => {
  it("keeps matching suggestions when typing extends a cached prefix during throttling", async () => {
    const request = vi.fn<typeof fetch>(async () => anime());
    const suggest = createTitleAutocomplete({ request });
    await suggest("anime", "nar");
    expect(await suggest("anime", "naruto")).toEqual([
      { name: "Naruto", value: "anilist-anime:20" },
    ]);
    expect(await suggest("anime", "naruto unknown")).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shares a still-loading prefix instead of clearing the latest typed query", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const suggest = createTitleAutocomplete({ request });
    const first = suggest("anime", "nar");
    const latest = suggest("anime", "naruto");
    finish(anime());
    expect(await first).toHaveLength(1);
    expect(await latest).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("matches alternate titles when the displayed name is translated", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: { Page: { media: [
        { id: 20, title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" } },
      ] } },
    })));
    const suggest = createTitleAutocomplete({ request });
    await suggest("anime", "shi");
    expect(await suggest("anime", "shingeki")).toEqual([
      { name: "Attack on Titan", value: "anilist-anime:20" },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not consult sources before three characters or for oversized queries", async () => {
    const request = vi.fn<typeof fetch>();
    const suggest = createTitleAutocomplete({ request });
    for (const q of ["", " ", " n ", "na", "x".repeat(101)]) {
      expect(await suggest("anime", q)).toEqual([]);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("requests only minimal AniList titles and returns IDs accepted by /anime", async () => {
    const request = vi.fn<typeof fetch>(async () => anime());
    const suggest = createTitleAutocomplete({ request });
    expect(await suggest("anime", "Nar")).toEqual([
      { name: "Naruto", value: "anilist-anime:20" },
    ]);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graphql.anilist.co");
    const body = JSON.parse(init.body as string);
    expect(body.variables.search).toBe("nar");
    expect(body.query).toContain("isAdult: false");
    expect(body.query).not.toMatch(/description|studios|coverImage/);
  });

  it("keeps Japanese manga and the existing safe/suggestive content filters", async () => {
    const request = vi.fn<typeof fetch>(async () => manga());
    const suggest = createTitleAutocomplete({ request });
    expect(await suggest("manga", "One")).toEqual([
      { name: "One Piece", value: `mangadex:${uuid}` },
    ]);
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.searchParams.get("originalLanguage[]")).toBe("ja");
    expect(url.searchParams.getAll("contentRating[]")).toEqual(["safe", "suggestive"]);
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("reuses normalized cached queries for sixty seconds", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>(async () => anime());
    const suggest = createTitleAutocomplete({ request, now: () => time });
    await suggest("anime", "Naruto");
    time += 59_000;
    expect(await suggest("anime", "  NARUTO  ")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    time += 1_001;
    await suggest("anime", "naruto");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares in-flight queries and rejects extra work while a source is busy", async () => {
    let finish!: (r: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { finish = resolve; }));
    const suggest = createTitleAutocomplete({ request });
    const first = suggest("anime", "naruto");
    const second = suggest("anime", "NARUTO");
    expect(await suggest("anime", "bleach")).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    finish(anime());
    expect(await first).toEqual(await second);
  });

  it("limits different queries to one new request per source every three seconds", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>(async () => anime());
    const suggest = createTitleAutocomplete({ request, now: () => time });
    await suggest("anime", "nar");
    expect(await suggest("anime", "ble")).toEqual([]);
    time += 3_000;
    await suggest("anime", "ble");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps separate, bounded budgets for anime and manga", async () => {
    const request = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("anilist") ? anime() : manga());
    const suggest = createTitleAutocomplete({ request });
    expect(await suggest("anime", "nar")).toHaveLength(1);
    expect(await suggest("manga", "one")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts slow requests and responds without waiting for a hanging source", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const onFailure = vi.fn();
    const suggest = createTitleAutocomplete({ request, onFailure });
    const result = suggest("anime", "nar");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await result).toEqual([]);
    const init = request.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledWith("anime", "TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors source rate-limit cooldowns while still serving cached results", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(anime())
      .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "60" } }));
    const onFailure = vi.fn();
    const suggest = createTitleAutocomplete({ request, now: () => time, onFailure });
    await suggest("anime", "nar");
    time += 3_000;
    expect(await suggest("anime", "ble")).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith("anime", "HTTP_429");
    expect(await suggest("anime", "nar")).toHaveLength(1);
    time += 59_999;
    await suggest("anime", "dragon");
    expect(request).toHaveBeenCalledTimes(2);
    time += 1;
    await suggest("anime", "dragon");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("briefly caches failures and does not retry an unavailable source per keystroke", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>(async () => { throw new Error("network unavailable"); });
    const onFailure = vi.fn();
    const suggest = createTitleAutocomplete({ request, now: () => time, onFailure });
    expect(await suggest("manga", "one")).toEqual([]);
    time += 9_999;
    await suggest("manga", "one");
    await suggest("manga", "berserk");
    expect(request).toHaveBeenCalledTimes(1);
    time += 1;
    await suggest("manga", "one");
    expect(request).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed responses instead of making up suggestions", async () => {
    const onFailure = vi.fn();
    const suggest = createTitleAutocomplete({
      request: vi.fn(async () => new Response('{"errors":[{"message":"failed"}]}')),
      onFailure,
    });
    expect(await suggest("anime", "nar")).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith("anime", "INVALID_RESPONSE");
  });

  it("deduplicates titles, limits ten options and preserves valid identifiers", async () => {
    const rows = [
      { id: 1, title: { english: "A".repeat(150) } },
      { id: 2, title: { english: "a".repeat(150) } },
      { id: -1, title: { english: "Invalid" } },
      ...Array.from({ length: 20 }, (_, i) => ({ id: i + 3, title: { english: `Title ${i}` } })),
    ];
    const suggest = createTitleAutocomplete({ request: vi.fn(async () => anime(rows)) });
    const choices = await suggest("anime", "titles");
    expect(choices).toHaveLength(10);
    expect(choices[0].name).toHaveLength(100);
    expect(choices.every(c => /^anilist-anime:\d+$/.test(c.value))).toBe(true);
  });

  it("responds once with real suggestions from the resolver", async () => {
    const interaction = {
      options: { getFocused: () => ({ name: "titulo", value: "nar" }) },
      respond: vi.fn(async () => {}),
    } as unknown as AutocompleteInteraction;
    const suggest = createTitleAutocomplete({ request: vi.fn(async () => anime()) });
    await respondTitleAutocomplete(interaction, "anime", suggest);
    expect(interaction.respond).toHaveBeenCalledExactlyOnceWith([
      { name: "Naruto", value: "anilist-anime:20" },
    ]);
  });

  it("never retries a failed Discord acknowledgement", async () => {
    const failure = new Error("Discord callback failed");
    const interaction = {
      options: { getFocused: () => ({ name: "titulo", value: "nar" }) },
      respond: vi.fn(async () => { throw failure; }),
    } as unknown as AutocompleteInteraction;
    const suggest = createTitleAutocomplete({ request: vi.fn(async () => anime()) });
    await expect(respondTitleAutocomplete(interaction, "anime", suggest)).rejects.toThrow(failure);
    expect(interaction.respond).toHaveBeenCalledTimes(1);
  });
});