const MANGADEX_API = "https://api.mangadex.org";

interface MangaDexTitle {
  [lang: string]: string;
}

interface MangaDexTag {
  id: string;
  type: string;
  attributes: { name: MangaDexTitle; group: string };
}

interface MangaDexRelationship {
  id: string;
  type: string;
  attributes?: { fileName?: string; name?: string };
}

interface MangaDexManga {
  id: string;
  type: string;
  attributes: {
    title: MangaDexTitle;
    altTitles: MangaDexTitle[];
    description: MangaDexTitle;
    status: string | null;
    lastChapter: string | null;
    year: number | null;
    tags: MangaDexTag[];
  };
  relationships: MangaDexRelationship[];
}

export interface MangaDexResult {
  source: "mangadex";
  id: string;
  mainTitle: string;
  nativeTitle: string | null;
  romajiTitle: string | null;
  synonyms: string[];
  description: string | null;
  coverUrl: string | null;
  score: null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  year: number | null;
}

function pickTitle(titles: MangaDexTitle, preferred: string[]): string | null {
  for (const lang of preferred) {
    if (titles[lang]) return titles[lang];
  }
  const firstKey = Object.keys(titles)[0];
  return firstKey ? (titles[firstKey] ?? null) : null;
}

function mapStatus(status: string | null): string | null {
  const map: Record<string, string> = {
    ongoing: "RELEASING",
    completed: "FINISHED",
    hiatus: "HIATUS",
    cancelled: "CANCELLED",
  };
  return status ? (map[status] ?? status.toUpperCase()) : null;
}

function buildCoverUrl(manga: MangaDexManga): string | null {
  const coverRel = manga.relationships.find((r) => r.type === "cover_art");
  if (!coverRel?.attributes?.fileName) return null;
  return `https://uploads.mangadex.org/covers/${manga.id}/${coverRel.attributes.fileName}.512.jpg`;
}

function extractGenres(tags: MangaDexTag[]): string[] {
  return tags
    .filter((t) => t.attributes.group === "genre" || t.attributes.group === "theme")
    .map((t) => pickTitle(t.attributes.name, ["en", "pt-br", "pt"]) ?? "")
    .filter(Boolean)
    .slice(0, 8);
}

function extractSynonyms(altTitles: MangaDexTitle[], mainTitle: string): string[] {
  const seen = new Set<string>([mainTitle.toLowerCase()]);
  const result: string[] = [];
  for (const alt of altTitles) {
    for (const lang of ["en", "ko", "ja", "pt-br", "pt", "ro"]) {
      const t = alt[lang];
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        result.push(t);
      }
    }
    if (result.length >= 6) break;
  }
  return result;
}

export async function getMangaDexById(id: string): Promise<MangaDexResult | null> {
  try {
    const res = await fetch(
      `${MANGADEX_API}/manga/${encodeURIComponent(id)}?includes[]=cover_art`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data: MangaDexManga; result: string };
    if (json.result !== "ok" || !json.data) return null;
    const manga = json.data;
    const attr = manga.attributes;
    const mainTitle = pickTitle(attr.title, ["en", "ko", "ja-ro", "ja"]) ?? "Sem título";
    const nativeTitle = attr.title["ko"] ?? null;
    const romajiTitle = attr.title["ja-ro"] ?? attr.title["ja"] ?? null;
    const synonyms = extractSynonyms(attr.altTitles, mainTitle);
    const descEn = attr.description["en"] ?? attr.description["pt-br"] ?? null;
    const chapters = attr.lastChapter ? parseInt(attr.lastChapter, 10) || null : null;
    return {
      source: "mangadex",
      id: manga.id,
      mainTitle,
      nativeTitle,
      romajiTitle,
      synonyms,
      description: descEn,
      coverUrl: buildCoverUrl(manga),
      score: null,
      genres: extractGenres(attr.tags),
      chapters: isNaN(chapters as number) ? null : chapters,
      status: mapStatus(attr.status),
      siteUrl: `https://mangadex.org/title/${manga.id}`,
      year: attr.year,
    };
  } catch {
    return null;
  }
}

export async function searchMangaDex(search: string): Promise<MangaDexResult[]> {
  const params = new URLSearchParams({
    title: search,
    limit: "5",
    "originalLanguage[]": "ko",
    "includes[]": "cover_art",
    "order[relevance]": "desc",
  });

  const res = await fetch(`${MANGADEX_API}/manga?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`MangaDex API error: ${res.status}`);

  const json = (await res.json()) as { data: MangaDexManga[]; result: string };
  if (json.result !== "ok" || !json.data?.length) return [];

  return json.data.map((manga): MangaDexResult => {
    const attr = manga.attributes;
    const mainTitle =
      pickTitle(attr.title, ["en", "ko", "ja-ro", "ja"]) ?? "Sem título";
    const nativeTitle = attr.title["ko"] ?? null;
    const romajiTitle = attr.title["ja-ro"] ?? attr.title["ja"] ?? null;
    const synonyms = extractSynonyms(attr.altTitles, mainTitle);
    const descEn = attr.description["en"] ?? attr.description["pt-br"] ?? null;
    const chapters = attr.lastChapter ? parseInt(attr.lastChapter, 10) || null : null;

    return {
      source: "mangadex",
      id: manga.id,
      mainTitle,
      nativeTitle,
      romajiTitle,
      synonyms,
      description: descEn,
      coverUrl: buildCoverUrl(manga),
      score: null,
      genres: extractGenres(attr.tags),
      chapters: isNaN(chapters as number) ? null : chapters,
      status: mapStatus(attr.status),
      siteUrl: `https://mangadex.org/title/${manga.id}`,
      year: attr.year,
    };
  });
}

export async function hasPtBrChapters(mangadexId: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      manga: mangadexId,
      "translatedLanguage[]": "pt-br",
      limit: "1",
    });
    const res = await fetch(`${MANGADEX_API}/chapter?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data: unknown[]; result: string; total: number };
    return json.result === "ok" && json.total > 0;
  } catch {
    return false;
  }
}

/**
 * Busca mangás japoneses (originalLanguage = ja) no MangaDex.
 * Diferente de searchMangaDex que foca em manhwa coreano (ko).
 */
/**
 * Busca no MangaDex sem filtro de idioma original.
 * Usado no Tier 2 do /manhwa para ampliar cobertura de busca.
 */
export async function searchMangaDexAny(
  search: string,
  limit = 5
): Promise<MangaDexResult[]> {
  const params = new URLSearchParams({
    title: search,
    limit: String(limit),
    "includes[]": "cover_art",
    "order[relevance]": "desc",
  });

  try {
    const res = await fetch(`${MANGADEX_API}/manga?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data: MangaDexManga[]; result: string };
    if (json.result !== "ok" || !json.data?.length) return [];

    return json.data.map((manga): MangaDexResult => {
      const attr = manga.attributes;
      const mainTitle =
        pickTitle(attr.title, ["en", "ko", "ja-ro", "ja"]) ?? "Sem título";
      const nativeTitle = attr.title["ko"] ?? attr.title["ja"] ?? null;
      const romajiTitle = attr.title["ja-ro"] ?? attr.title["ko-ro"] ?? null;
      const synonyms = extractSynonyms(attr.altTitles, mainTitle);
      const descEn = attr.description["en"] ?? attr.description["pt-br"] ?? null;
      const chapters = attr.lastChapter ? parseInt(attr.lastChapter, 10) || null : null;
      return {
        source: "mangadex",
        id: manga.id,
        mainTitle,
        nativeTitle,
        romajiTitle,
        synonyms,
        description: descEn,
        coverUrl: buildCoverUrl(manga),
        score: null,
        genres: extractGenres(attr.tags),
        chapters: isNaN(chapters as number) ? null : chapters,
        status: mapStatus(attr.status),
        siteUrl: `https://mangadex.org/title/${manga.id}`,
        year: attr.year,
      };
    });
  } catch {
    return [];
  }
}

export async function searchMangaDexJp(
  search: string,
  limit = 8,
  includedTagId?: string
): Promise<MangaDexResult[]> {
  const params = new URLSearchParams({
    title: search,
    limit: String(limit),
    "originalLanguage[]": "ja",
    "includes[]": "cover_art",
    "order[relevance]": "desc",
  });
  if (includedTagId) {
    params.append("includedTags[]", includedTagId);
  }

  try {
    const res = await fetch(`${MANGADEX_API}/manga?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data: MangaDexManga[]; result: string };
    if (json.result !== "ok" || !json.data?.length) return [];

    return json.data.map((manga): MangaDexResult => {
      const attr = manga.attributes;
      const mainTitle =
        pickTitle(attr.title, ["en", "ja-ro", "ja"]) ?? "Sem título";
      const nativeTitle = attr.title["ja"] ?? null;
      const romajiTitle = attr.title["ja-ro"] ?? null;
      const synonyms = extractSynonyms(attr.altTitles, mainTitle);
      const descEn = attr.description["en"] ?? attr.description["pt-br"] ?? null;
      const chapters = attr.lastChapter ? parseInt(attr.lastChapter, 10) || null : null;

      return {
        source: "mangadex",
        id: manga.id,
        mainTitle,
        nativeTitle,
        romajiTitle,
        synonyms,
        description: descEn,
        coverUrl: buildCoverUrl(manga),
        score: null,
        genres: extractGenres(attr.tags),
        chapters: isNaN(chapters as number) ? null : chapters,
        status: mapStatus(attr.status),
        siteUrl: `https://mangadex.org/title/${manga.id}`,
        year: attr.year,
      };
    });
  } catch {
    return [];
  }
}

export async function findMangaDexIdByTitle(title: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      title,
      limit: "1",
      "originalLanguage[]": "ko",
      "order[relevance]": "desc",
    });
    const res = await fetch(`${MANGADEX_API}/manga?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: { id: string }[]; result: string };
    if (json.result !== "ok" || !json.data?.length) return null;
    return json.data[0].id;
  } catch {
    return null;
  }
}
