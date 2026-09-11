import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const {
  getCurrentSeasonData,
  getSeasonAnimePage,
} = await import("./routes/season-service-data.js");
const { buildSeasonMessagePayload } = await import("./routes/discord.js");
const { execute: executeTemporada } = await import("./bot/commands/temporada.js");

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function anilistAnimeItem(index: number) {
  return {
    id: 10_000 + index,
    title: { romaji: `AniList Anime ${index}`, english: `AniList Anime ${index}` },
    averageScore: 80,
    genres: ["Action", "Fantasy"],
    episodes: 12,
    status: "RELEASING",
    siteUrl: `https://anilist.co/anime/${10_000 + index}`,
    coverImage: { color: "#224466", large: `https://images.test/anilist-${index}.jpg` },
    description: `Sinopse AniList ${index}`,
    studios: { nodes: [{ name: "Studio AniList" }] },
    startDate: { month: 9, day: 1 },
    nextAiringEpisode: null,
  };
}

function tenraiAnimeItem(index: number) {
  return {
    mal_id: 20_000 + index,
    title: `Tenrai Anime ${index}`,
    title_english: `Tenrai Anime ${index}`,
    url: `https://myanimelist.net/anime/${20_000 + index}`,
    images: { jpg: { large_image_url: `https://images.test/tenrai-${index}.jpg` } },
    score: 8.1,
    episodes: 24,
    synopsis: `Sinopse Tenrai ${index}`,
    genres: [{ name: "Drama" }, { name: "Fantasy" }],
    status: "Currently Airing",
  };
}

function tenraiMangaItem(index: number, type: "manga" | "manhwa" = "manga") {
  return {
    mal_id: 30_000 + index,
    title: `Tenrai ${type} ${index}`,
    title_english: `Tenrai ${type} ${index}`,
    type,
    url: `https://myanimelist.net/${type}/${30_000 + index}`,
    images: { jpg: { large_image_url: `https://images.test/${type}-${index}.jpg` } },
    score: 7.7,
    volumes: 8,
    synopsis: `Sinopse Tenrai ${type} ${index}`,
    genres: [{ name: "Romance" }],
  };
}

function anilistAnimeResponse() {
  return {
    data: {
      Page: {
        media: Array.from({ length: 20 }, (_, index) => anilistAnimeItem(index)),
      },
    },
  };
}

function anilistMangaResponse() {
  return {
    data: {
      Page: {
        media: Array.from({ length: 3 }, (_, index) => ({
          id: 40_000 + index,
          title: { romaji: `AniList Manga ${index}`, english: `AniList Manga ${index}` },
          siteUrl: `https://anilist.co/manga/${40_000 + index}`,
          coverImage: { large: `https://images.test/anilist-manga-${index}.jpg` },
          averageScore: 75,
          volumes: 5,
          description: `Sinopse AniList manga ${index}`,
          genres: ["Drama"],
          status: "RELEASING",
        })),
      },
    },
  };
}

function installAniListSuccess() {
  fetchMock.mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    return response(body.query.includes("CurrentManga") ? anilistMangaResponse() : anilistAnimeResponse());
  });
}

function installTenraiFallback() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://graphql.anilist.co") return response({ error: "unavailable" }, 503);
    if (url.includes("/seasons/")) {
      return response({ data: Array.from({ length: 20 }, (_, index) => tenraiAnimeItem(index)) });
    }
    const type = new URL(url).searchParams.get("type") === "manhwa" ? "manhwa" : "manga";
    return response({
      data: Array.from({ length: 10 }, (_, index) => tenraiMangaItem(index, type)),
    });
  });
}

async function settleAfterRetries<T>(promise: Promise<T>) {
  await vi.runAllTimersAsync();
  return promise;
}

function commandInteraction() {
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  return {
    interaction: {
      options: {
        getString: () => "atual",
        getInteger: () => null,
      },
      deferReply,
      editReply,
      channel: undefined,
      user: { id: "user-1" },
    } as unknown as ChatInputCommandInteraction,
    deferReply,
    editReply,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fallback de temporada", () => {
  it("responde /temporada com dados AniList e paginação", async () => {
    installAniListSuccess();
    const { interaction, editReply } = commandInteraction();

    await executeTemporada(interaction);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reply = editReply.mock.calls[0]?.[0] as {
      embeds: Array<{ toJSON: () => { description?: string; footer?: { text?: string } } }>;
      components: unknown[];
    };
    const embed = reply.embeds[0]!.toJSON();
    expect(embed.description).toContain("AniList Anime 0");
    expect(embed.footer?.text).toContain("AniList");
    expect(reply.components).toHaveLength(1);
  });

  it.each([1, 2])("usa Tenrai na página %s quando AniList falha", async (page) => {
    installTenraiFallback();

    const list = await settleAfterRetries(getSeasonAnimePage("summer", 2026, page));

    expect(list).toHaveLength(20);
    expect(list[0]).toMatchObject({
      id: 20_000,
      source: "MAL/Tenrai",
      description: "Sinopse Tenrai 0",
      coverImage: { large: "https://images.test/tenrai-0.jpg" },
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`page=${page}`))).toBe(true);
  });

  it("mantém thumbnails, sinopses e paginação no catálogo AniList", async () => {
    installAniListSuccess();

    const catalog = await getCurrentSeasonData();
    const firstPage = buildSeasonMessagePayload(catalog, true, true, 0);
    const lastPage = buildSeasonMessagePayload(catalog, true, true, 4);

    expect(catalog.anime[0]).toMatchObject({
      imageUrl: "https://images.test/anilist-0.jpg",
      synopsis: "Sinopse AniList 0",
    });
    expect(catalog.manga[0]).toMatchObject({
      imageUrl: "https://images.test/anilist-manga-0.jpg",
      synopsis: "Sinopse AniList manga 0",
    });
    expect(firstPage.embeds[0]?.footer).toMatchObject({ text: expect.stringContaining("Página 1/5") });
    expect(lastPage.embeds[0]?.footer).toMatchObject({ text: expect.stringContaining("Página 5/5") });
    expect(firstPage.components[0]?.components[2]).toMatchObject({ disabled: false });
    expect(lastPage.components[0]?.components[2]).toMatchObject({ disabled: true });
  });

  it("mantém thumbnails, sinopses e paginação no catálogo Tenrai", async () => {
    installTenraiFallback();

    const catalog = await settleAfterRetries(getCurrentSeasonData());
    const firstPage = buildSeasonMessagePayload(catalog, true, true, 0);
    const lastPage = buildSeasonMessagePayload(catalog, true, true, 7);

    expect(catalog.anime[0]).toMatchObject({
      imageUrl: "https://images.test/tenrai-0.jpg",
      synopsis: "Sinopse Tenrai 0",
    });
    expect(catalog.manga[0]).toMatchObject({
      imageUrl: "https://images.test/manga-0.jpg",
      synopsis: "Sinopse Tenrai manga 0",
    });
    expect(catalog.manga.some((item) => item.category === "manhwa")).toBe(true);
    expect(firstPage.embeds[0]?.footer).toMatchObject({ text: expect.stringContaining("Página 1/8") });
    expect(lastPage.embeds[0]?.footer).toMatchObject({ text: expect.stringContaining("Página 8/8") });
  });

  it("retorna erro explícito quando AniList e Tenrai falham", async () => {
    fetchMock.mockResolvedValue(response({ error: "unavailable" }, 503));

    const catalogRequest = getCurrentSeasonData();
    const catalogExpectation = expect(catalogRequest).rejects.toThrow(
      "AniList e Tenrai indisponíveis para o catálogo de anime",
    );
    await vi.runAllTimersAsync();
    await catalogExpectation;

    const { interaction, editReply } = commandInteraction();
    const commandRequest = executeTemporada(interaction);
    await vi.runAllTimersAsync();
    await commandRequest;
    expect(editReply.mock.calls[0]?.[0]).toContain("Erro ao buscar a temporada");
  });
});