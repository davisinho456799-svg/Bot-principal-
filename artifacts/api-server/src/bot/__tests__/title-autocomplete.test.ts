import type { AutocompleteInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTitleAutocomplete as createSuggestions, respondTitleAutocomplete } from "../title-autocomplete.js";

const uuid = "11111111-1111-1111-1111-111111111111";
const anime = (media = [{ id: 20, title: { english: "Naruto" } }]) =>
  new Response(JSON.stringify({ data: { Page: { media } } }));
const manga = () => new Response(JSON.stringify({
  result: "ok", data: [{ id: uuid, attributes: { title: { en: "One Piece" } } }],
}));
const tenrai = (data: Array<Record<string, unknown>> = []) =>
  new Response(JSON.stringify({ data }));

// Keep the existing AniList/MangaDex contract tests isolated from the added source.
function createTitleAutocomplete(options: Parameters<typeof createSuggestions>[0] = {}) {
  const request = options.request ?? fetch;
  return createSuggestions({
    ...options,
    request: (input, init) => String(input).includes("api.tenrai.org")
      ? Promise.resolve(tenrai()) : request(input, init),
  });
}

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

  it("shows the matching alternate title instead of an unrelated English name", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: { Page: { media: [
        { id: 20, title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" } },
      ] } },
    })));
    const suggest = createTitleAutocomplete({ request });
    await suggest("anime", "shi");
    expect(await suggest("anime", "shingeki")).toEqual([
      { name: "Shingeki no Kyojin", value: "anilist-anime:20" },
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
    expect(body.query).not.toContain("isAdult: false");
    expect(body.query).toContain("synonyms");
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

describe("fast AniList and Tenrai anime suggestions", () => {
  it("includes the reported adult title and deduplicates translated/native aliases across sources", async () => {
    const request = vi.fn<typeof fetch>(async input =>
      String(input).includes("tenrai")
        ? tenrai([{ mal_id: 29575, title: "Mankitsu Happening", title_english: null }])
        : anime([{ id: 21222, title: { english: "Manga Café Mishaps", romaji: "Mankitsu Happening" } }]));
    const suggest = createSuggestions({ request });
    const choices = await suggest("anime", "mankitsu");
    expect(choices).toEqual([{ name: "Mankitsu Happening", value: "anilist-anime:21222" }]);
    expect(await suggest("anime", "mankitsu happening")).toEqual(choices);
    expect(request).toHaveBeenCalledTimes(2);
    const [, init] = request.mock.calls.find(([url]) => String(url).includes("anilist"))!;
    expect(JSON.parse(init!.body as string).query).not.toMatch(/isAdult/);
    const url = new URL(String(request.mock.calls.find(([url]) => String(url).includes("tenrai"))![0]));
    expect(url.searchParams.get("q")).toBe("mankitsu");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("sfw")).toBe(false);
  });

  it("returns Tenrai IDs accepted by /anime when AniList has no results", async () => {
    const request = vi.fn<typeof fetch>(async input => String(input).includes("tenrai")
      ? tenrai([{ mal_id: 29575, title: "Mankitsu Happening", title_synonyms: ["Cafe Mishaps"] }])
      : anime([]));
    const suggest = createSuggestions({ request });
    expect(await suggest("anime", "caf")).toEqual([
      { name: "Cafe Mishaps", value: "tenrai:29575" },
    ]);
    expect(await suggest("anime", "cafe")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["anime", "tenrai"])("responds with the fast source instead of waiting for slow %s", async slow => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const request = vi.fn<typeof fetch>(async input => {
      const source = String(input).includes("tenrai") ? "tenrai" : "anime";
      if (source === slow) return new Promise<Response>(() => {});
      return source === "tenrai" ? tenrai([{ mal_id: 20, title: "Naruto" }]) : anime();
    });
    const suggest = createSuggestions({ request, onFailure });
    let resolved = false;
    const result = suggest("anime", "nar").then(choices => { resolved = true; return choices; });
    await vi.advanceTimersByTimeAsync(80);
    expect(resolved).toBe(true);
    expect(await result).toHaveLength(1);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_120);
    const [, init] = request.mock.calls.find(([input]) =>
      String(input).includes("tenrai") === (slow === "tenrai"))!;
    expect(init!.signal!.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledWith(slow, "TIMEOUT");
    expect(await suggest("anime", "naruto")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enriches the cache with later titles without replying to Discord twice", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(input => String(input).includes("tenrai")
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(anime()));
    const suggest = createSuggestions({ request });
    const interaction = {
      options: { getFocused: () => ({ name: "titulo", value: "nar" }) },
      respond: vi.fn(async () => {}),
    } as unknown as AutocompleteInteraction;
    const result = respondTitleAutocomplete(interaction, "anime", suggest);
    await vi.advanceTimersByTimeAsync(80);
    await result;
    expect(interaction.respond).toHaveBeenCalledTimes(1);
    finish(tenrai([{ mal_id: 21, title: "Naruto Shippuden" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(await suggest("anime", "naruto")).toHaveLength(2);
    expect(interaction.respond).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an AniList rate limit suspend healthy Tenrai queries", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>(async input => String(input).includes("tenrai")
      ? tenrai([{ mal_id: 29575, title: "Mankitsu Happening" }])
      : new Response("", { status: 429, headers: { "retry-after": "60" } }));
    const onFailure = vi.fn();
    const suggest = createSuggestions({ request, now: () => time, onFailure });
    expect(await suggest("anime", "mankitsu")).toHaveLength(1);
    time += 3_000;
    expect(await suggest("anime", "happening")).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => String(input).includes("anilist"))).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => String(input).includes("tenrai"))).toHaveLength(2);
    expect(onFailure).toHaveBeenCalledWith("anime", "HTTP_429");
  });

  it("expires empty fallback results when the missing provider becomes eligible again", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>(async input => String(input).includes("tenrai")
      ? tenrai() : time < 160_000
        ? new Response("", { status: 429, headers: { "retry-after": "60" } })
        : anime());
    const suggest = createSuggestions({ request, now: () => time, onFailure: vi.fn() });
    expect(await suggest("anime", "initial")).toEqual([]);
    time = 159_999;
    expect(await suggest("anime", "nar")).toEqual([]);
    time = 160_000;
    expect(await suggest("anime", "nar")).toEqual([{ name: "Naruto", value: "anilist-anime:20" }]);
    expect(request.mock.calls.filter(([input]) => String(input).includes("anilist"))).toHaveLength(2);
  });

  it("keeps AniList available when Tenrai fails and rejects malformed Tenrai IDs", async () => {
    let time = 100_000;
    const onFailure = vi.fn();
    const request = vi.fn<typeof fetch>(async input => String(input).includes("tenrai")
      ? new Response("", { status: 503 }) : anime());
    const suggest = createSuggestions({ request, now: () => time, onFailure });
    expect(await suggest("anime", "nar")).toHaveLength(1);
    time += 3_000;
    expect(await suggest("anime", "other")).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => String(input).includes("tenrai"))).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledWith("tenrai", "HTTP_503");
    const malformed = createSuggestions({
      request: vi.fn(async input => String(input).includes("tenrai")
        ? tenrai([{ mal_id: -1, title: "Invalid" }, { mal_id: "12", title: "String ID" }])
        : anime([])),
    });
    expect(await malformed("anime", "bad")).toEqual([]);
  });

  it("keeps both requests shared across repeated queries and bounds the merged choices", async () => {
    const request = vi.fn<typeof fetch>(async input => String(input).includes("tenrai")
      ? tenrai(Array.from({ length: 14 }, (_, i) => ({ mal_id: i + 1, title: `Tenrai ${i}` })))
      : anime(Array.from({ length: 14 }, (_, i) => ({ id: i + 1, title: { english: `AniList ${i}` } }))));
    const suggest = createSuggestions({ request });
    const [first, second] = await Promise.all([suggest("anime", "title"), suggest("anime", "TITLE")]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(20);
    expect(request).toHaveBeenCalledTimes(2);
    expect(first.slice(10).every(choice => choice.value.startsWith("tenrai:"))).toBe(true);
  });
});