import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutocompleteInteraction } from "discord.js";
import { respondAutocomplete, respondAutocompleteAnime, respondSourceAutocomplete } from "../autocomplete.js";

const providers = vi.hoisted(() => ({
  searchAnime: vi.fn(),
  searchManhwa: vi.fn(),
  searchComick: vi.fn(),
  searchMangaDex: vi.fn(),
  searchMangaUpdates: vi.fn(),
  searchJikan: vi.fn(),
  searchJikanAnimeAny: vi.fn(),
  searchTenraiAnime: vi.fn(),
  searchTenraiManga: vi.fn(),
  searchKitsu: vi.fn(),
  searchVNDB: vi.fn(),
  searchVNDBSFW: vi.fn(),
  searchErogamescape: vi.fn(),
}));

vi.mock("../anilist.js", () => ({
  searchAnime: providers.searchAnime,
  searchManhwa: providers.searchManhwa,
}));
vi.mock("../comick.js", () => ({ searchComick: providers.searchComick }));
vi.mock("../mangadex.js", () => ({ searchMangaDex: providers.searchMangaDex }));
vi.mock("../mangaupdates.js", () => ({ searchMangaUpdates: providers.searchMangaUpdates }));
vi.mock("../jikan.js", () => ({
  searchJikan: providers.searchJikan,
  searchJikanAnimeAny: providers.searchJikanAnimeAny,
}));
vi.mock("../tenrai-fallback.js", () => ({
  searchTenraiAnime: providers.searchTenraiAnime,
  searchTenraiManga: providers.searchTenraiManga,
  titleOfTenrai: (item: { title?: string; title_english?: string | null } | null) =>
    item?.title_english?.trim() || item?.title?.trim() || "Sem título",
}));
vi.mock("../kitsu.js", () => ({ searchKitsu: providers.searchKitsu }));
vi.mock("../vndb.js", () => ({
  searchVNDB: providers.searchVNDB,
  searchVNDBSFW: providers.searchVNDBSFW,
}));
vi.mock("../erogamescape.js", () => ({ searchErogamescape: providers.searchErogamescape }));

function interaction(): AutocompleteInteraction {
  return { respond: vi.fn(async () => undefined) } as unknown as AutocompleteInteraction;
}

beforeEach(() => {
  for (const provider of Object.values(providers)) provider.mockResolvedValue([]);
});

describe("subscription source autocomplete", () => {
  it("offers Kitsu and Tenrai only in the anime source picker", async () => {
    providers.searchAnime.mockResolvedValue([{ id: 11, title: { english: "Anime Choice" } }]);
    providers.searchJikanAnimeAny.mockResolvedValue([{ malId: 12, mainTitle: "Anime Choice" }]);
    providers.searchTenraiAnime.mockResolvedValue([{ mal_id: 13, title: "Anime Choice" }]);
    providers.searchKitsu.mockResolvedValue([{
      kitsuId: "14",
      mainTitle: "Anime Choice",
      englishTitle: "Anime Choice",
      synonyms: [],
    }]);

    const anime = interaction();
    await respondSourceAutocomplete(anime, "anime", "Anime Choice", "");
    const animeChoices = vi.mocked(anime.respond).mock.calls[0]![0] as Array<{ value: string }>;
    expect(animeChoices.map(choice => choice.value)).toEqual([
      "anilist-anime:11", "jikan:12", "tenrai:13", "kitsu:14",
    ]);

    const manga = interaction();
    await respondSourceAutocomplete(manga, "manga", "Manga Choice", "", "Manga");
    const mangaChoices = vi.mocked(manga.respond).mock.calls[0]![0] as Array<{ value: string }>;
    expect(mangaChoices.some(choice => choice.value.startsWith("kitsu:"))).toBe(false);
    expect(providers.searchKitsu).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["manga", "Manga", "manga"],
    ["manhwa", "Manhwa", "manhwa"],
  ] as const)("searches Tenrai for the selected %s category", async (kind, updatesKind, tenraiKind) => {
    providers.searchTenraiManga.mockResolvedValue([{ mal_id: 88, title: `${kind} Selection` }]);
    const autocomplete = interaction();
    await respondAutocomplete(autocomplete, `${kind} Selection`, null, false, updatesKind, true);
    expect(providers.searchTenraiManga).toHaveBeenCalledWith(`${kind} Selection`, tenraiKind);
    expect(vi.mocked(autocomplete.respond).mock.calls[0]![0]).toContainEqual({
      name: `${kind} Selection`,
      value: "tenrai:88",
    });
  });

  it("includes Kitsu and Tenrai choices in anime title autocomplete", async () => {
    providers.searchTenraiAnime.mockResolvedValue([{ mal_id: 31, title: "Anime Result" }]);
    providers.searchKitsu.mockResolvedValue([{
      kitsuId: "32",
      mainTitle: "Anime Result",
      englishTitle: "Anime Result",
      synonyms: [],
    }]);
    const autocomplete = interaction();
    await respondAutocompleteAnime(autocomplete, "Anime Result");
    const values = (vi.mocked(autocomplete.respond).mock.calls[0]![0] as Array<{ value: string }>)
      .map(choice => choice.value);
    expect(values).toContain("tenrai:31");
    expect(values).toContain("kitsu:32");
  });

  it("answers with an empty list when a provider returns malformed data", async () => {
    providers.searchTenraiManga.mockResolvedValue([null]);
    const autocomplete = interaction();
    await respondAutocomplete(autocomplete, "Malformed Result", null, false, "Manhwa", true);
    expect(autocomplete.respond).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("keeps Tenrai additions scoped to subscription autocomplete", async () => {
    providers.searchTenraiManga.mockResolvedValue([{ mal_id: 90, title: "Other Command Result" }]);
    const autocomplete = interaction();
    await respondAutocomplete(autocomplete, "Other Command Result");
    expect(providers.searchTenraiManga).not.toHaveBeenCalled();
    expect(autocomplete.respond).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("returns empty choices after providers exceed the autocomplete budget", async () => {
    vi.useFakeTimers();
    for (const provider of [
      providers.searchComick,
      providers.searchManhwa,
      providers.searchMangaDex,
      providers.searchMangaUpdates,
      providers.searchJikan,
      providers.searchTenraiManga,
    ]) {
      provider.mockReturnValue(new Promise(() => undefined));
    }

    const autocomplete = interaction();
    const response = respondAutocomplete(autocomplete, "Slow Provider Result", null, false, "Manhwa", true);
    await vi.advanceTimersByTimeAsync(1_000);
    await response;
    expect(autocomplete.respond).toHaveBeenCalledExactlyOnceWith([]);
    vi.useRealTimers();
  });
});
