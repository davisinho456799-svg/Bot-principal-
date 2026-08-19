import { asNullableNumber, fetchJson, uniqueTitles } from "../http";
import type { ChapterRecord, MangaRecord } from "../types";

const API_BASE = "https://api.mangadex.org";
const headers = { Accept: "application/json", "User-Agent": "MangaAggregator/1.0" };

type Localized = Record<string, string>;

interface MangaDexTag {
  attributes?: { name?: Localized; group?: string };
}

interface MangaDexRelationship {
  id?: string;
  type?: string;
  attributes?: { fileName?: string; name?: string };
}

interface MangaDexManga {
  id?: string;
  attributes?: {
    title?: Localized;
    altTitles?: Localized[];
    description?: Localized;
    status?: string | null;
    lastChapter?: string | null;
    year?: number | null;
    tags?: MangaDexTag[];
  };
  relationships?: MangaDexRelationship[];
}

function pickTitle(
  values: Localized | undefined,
  preferred = ["en", "pt-br", "pt", "ja-ro", "ja"],
): string | null {
  if (!values) return null;
  for (const language of preferred) {
    if (values[language]) return values[language];
  }
  return Object.values(values)[0] ?? null;
}

function normalizeStatus(value: string | null | undefined): string | null {
  if (!value) return null;
  return (
    {
      ongoing: "RELEASING",
      completed: "FINISHED",
      hiatus: "HIATUS",
      cancelled: "CANCELLED",
    }[value] ?? value.toUpperCase()
  );
}

function toRecord(manga: MangaDexManga): MangaRecord | null {
  if (!manga.id || !manga.attributes) return null;
  const title = pickTitle(manga.attributes.title);
  if (!title) return null;

  const cover = manga.relationships?.find(
    (relationship) => relationship.type === "cover_art",
  );
  const fileName = cover?.attributes?.fileName;
  const genres = (manga.attributes.tags ?? [])
    .filter(
      (tag) =>
        tag.attributes?.group === "genre" || tag.attributes?.group === "theme",
    )
    .map((tag) => pickTitle(tag.attributes?.name) ?? "")
    .filter(Boolean);

  return {
    source: "mangadex",
    id: manga.id,
    title,
    alternativeTitles: uniqueTitles(
      (manga.attributes.altTitles ?? []).flatMap((value) => Object.values(value)),
    ),
    description: pickTitle(manga.attributes.description),
    coverUrl: fileName
      ? `https://uploads.mangadex.org/covers/${manga.id}/${fileName}.512.jpg`
      : null,
    score: null,
    genres,
    status: normalizeStatus(manga.attributes.status),
    chapters: asNullableNumber(manga.attributes.lastChapter),
    year: manga.attributes.year ?? null,
    country: null,
    url: `https://mangadex.org/title/${manga.id}`,
  };
}

export async function searchMangaDex(query: string): Promise<MangaRecord[]> {
  const params = new URLSearchParams({
    title: query,
    limit: "10",
    "includes[]": "cover_art",
  });
  const response = await fetchJson<{ data?: MangaDexManga[] }>(
    `${API_BASE}/manga?${params.toString()}`,
    { headers },
  );

  return (response.data ?? [])
    .map(toRecord)
    .filter((item): item is MangaRecord => item !== null);
}

export async function getMangaDexChapters(
  mangaId: string,
  options: { language?: string; limit?: number } = {},
): Promise<ChapterRecord[]> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(options.limit ?? 100, 1), 500)),
    "order[chapter]": "desc",
    "includes[]": "scanlation_group",
  });
  params.append("translatedLanguage[]", options.language ?? "en");

  const response = await fetchJson<{
    data?: Array<{
      id?: string;
      attributes?: {
        chapter?: string | null;
        volume?: string | null;
        title?: string | null;
        translatedLanguage?: string | null;
        publishAt?: string | null;
      };
      relationships?: MangaDexRelationship[];
    }>;
  }>(`${API_BASE}/manga/${encodeURIComponent(mangaId)}/feed?${params}`, { headers });

  return (response.data ?? [])
    .filter((chapter) => chapter.id && chapter.attributes?.chapter != null)
    .map((chapter) => {
      const group = chapter.relationships?.find(
        (relationship) => relationship.type === "scanlation_group",
      );
      return {
        id: chapter.id as string,
        chapter: chapter.attributes?.chapter as string,
        volume: chapter.attributes?.volume ?? null,
        title: chapter.attributes?.title ?? null,
        language: chapter.attributes?.translatedLanguage ?? options.language ?? null,
        publishedAt: chapter.attributes?.publishAt ?? null,
        url: `https://mangadex.org/chapter/${chapter.id}`,
        group: group?.attributes?.name ?? group?.id ?? null,
        source: "mangadex" as const,
      };
    });
}