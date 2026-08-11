import { fetchJson, uniqueTitles } from "../http";
import type { MangaRecord } from "../types";

const API_URL = "https://graphql.anilist.co";
const searchQuery = `
  query SearchManga($search: String!) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
        id
        title { romaji english native userPreferred }
        synonyms
        description(asHtml: false)
        coverImage { large }
        averageScore
        genres
        status
        chapters
        startDate { year }
        siteUrl
        countryOfOrigin
      }
    }
  }
`;

interface AniListManga {
  id?: number;
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  };
  synonyms?: string[];
  description?: string | null;
  coverImage?: { large?: string | null };
  averageScore?: number | null;
  genres?: string[];
  status?: string | null;
  chapters?: number | null;
  startDate?: { year?: number | null };
  siteUrl?: string;
  countryOfOrigin?: string | null;
}

function toRecord(item: AniListManga): MangaRecord | null {
  const title = item.title?.userPreferred ?? item.title?.romaji ?? item.title?.english;
  if (item.id == null || !title) return null;
  return {
    source: "anilist",
    id: String(item.id),
    title,
    alternativeTitles: uniqueTitles([
      item.title?.romaji,
      item.title?.english,
      item.title?.native,
      ...(item.synonyms ?? []),
    ]).filter((value) => value.toLocaleLowerCase() !== title.toLocaleLowerCase()),
    description: item.description ?? null,
    coverUrl: item.coverImage?.large ?? null,
    score: item.averageScore ?? null,
    genres: item.genres ?? [],
    status: item.status ?? null,
    chapters: item.chapters ?? null,
    year: item.startDate?.year ?? null,
    country: item.countryOfOrigin ?? null,
    url: item.siteUrl ?? `https://anilist.co/manga/${item.id}`,
  };
}

export async function searchAniList(query: string): Promise<MangaRecord[]> {
  const response = await fetchJson<{
    data?: { Page?: { media?: AniListManga[] } };
  }>(API_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ query: searchQuery, variables: { search: query } }),
  });
  return (response.data?.Page?.media ?? [])
    .map(toRecord)
    .filter((item): item is MangaRecord => item !== null);
}