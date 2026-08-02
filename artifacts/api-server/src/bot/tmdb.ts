/**
 * TMDB (The Movie Database) — animes em formato de filme e informações de dublagem.
 * Documentação: https://developer.themoviedb.org/docs
 * Requer env: TMDB_API_KEY
 */

const TMDB_API = "https://api.themoviedb.org/3";

interface TMDBMovie {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  vote_count: number;
  poster_path: string | null;
  backdrop_path: string | null;
  genre_ids: number[];
  original_language: string;
  popularity: number;
}

interface TMDBMovieDetails {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  vote_count: number;
  runtime: number | null;
  status: string;
  poster_path: string | null;
  genres: { id: number; name: string }[];
  spoken_languages: { english_name: string; iso_639_1: string; name: string }[];
  production_companies: { name: string; origin_country: string }[];
  homepage: string | null;
  imdb_id: string | null;
}

interface TMDBTranslation {
  iso_639_1: string;
  iso_3166_1: string;
  name: string;
  english_name: string;
  data: { title: string; overview: string };
}

export interface TMDBResult {
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  releaseDate: string | null;
  score: number;
  voteCount: number;
  runtime: number | null;
  status: string | null;
  posterUrl: string | null;
  genres: string[];
  languages: string[];
  isDubbed: boolean; // tem PT-BR
  hasPortugueseOverview: boolean;
  imdbUrl: string | null;
  tmdbUrl: string;
  productionStudios: string[];
}

function getApiKey(): string {
  const key = process.env["TMDB_API_KEY"];
  if (!key) throw new Error("TMDB_API_KEY não configurado");
  return key;
}

const TMDB_GENRES: Record<number, string> = {
  28: "Ação", 12: "Aventura", 16: "Animação", 35: "Comédia",
  80: "Crime", 99: "Documentário", 18: "Drama", 10751: "Família",
  14: "Fantasia", 36: "História", 27: "Terror", 10402: "Música",
  9648: "Mistério", 10749: "Romance", 878: "Ficção Científica",
  10770: "TV Movie", 53: "Suspense", 10752: "Guerra", 37: "Faroeste",
};

function buildPosterUrl(path: string | null): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/w500${path}`;
}

export async function searchAnimeMovieTMDB(query: string): Promise<TMDBResult[]> {
  const key = getApiKey();

  // Busca filmes de animação japonesa
  const params = new URLSearchParams({
    api_key: key,
    query,
    language: "pt-BR",
    with_genres: "16",
    with_original_language: "ja",
    include_adult: "false",
    page: "1",
  });

  const res = await fetch(
    `${TMDB_API}/search/movie?${params.toString()}`,
    {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    }
  );
  if (!res.ok) throw new Error(`TMDB error: ${res.status}`);

  const json = (await res.json()) as { results: TMDBMovie[]; total_results: number };
  const top = json.results.slice(0, 5);

  return top.map((m): TMDBResult => ({
    id: m.id,
    title: m.title,
    originalTitle: m.original_title,
    overview: m.overview || "Sem sinopse disponível.",
    releaseDate: m.release_date || null,
    score: m.vote_average,
    voteCount: m.vote_count,
    runtime: null,
    status: null,
    posterUrl: buildPosterUrl(m.poster_path),
    genres: m.genre_ids
      .map((id) => TMDB_GENRES[id] ?? null)
      .filter((g): g is string => g !== null),
    languages: [],
    isDubbed: false,
    hasPortugueseOverview: !!m.overview,
    imdbUrl: null,
    tmdbUrl: `https://www.themoviedb.org/movie/${m.id}`,
    productionStudios: [],
  }));
}

export async function getAnimeMovieDetails(tmdbId: number): Promise<TMDBResult | null> {
  const key = getApiKey();

  const [detailsRes, translationsRes] = await Promise.allSettled([
    fetch(
      `${TMDB_API}/movie/${tmdbId}?api_key=${key}&language=pt-BR`,
      { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } }
    ),
    fetch(
      `${TMDB_API}/movie/${tmdbId}/translations?api_key=${key}`,
      { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } }
    ),
  ]);

  if (detailsRes.status === "rejected" || !detailsRes.value.ok) return null;

  const details = (await detailsRes.value.json()) as TMDBMovieDetails;

  // Verifica se tem tradução/dublagem PT-BR
  let isDubbed = false;
  let hasPortugueseOverview = !!details.overview;

  if (translationsRes.status === "fulfilled" && translationsRes.value.ok) {
    const tData = (await translationsRes.value.json()) as {
      translations: TMDBTranslation[];
    };
    const ptBr = tData.translations.find(
      (t) => t.iso_639_1 === "pt" && t.iso_3166_1 === "BR"
    );
    isDubbed = !!ptBr;
    if (ptBr?.data.overview) hasPortugueseOverview = true;
  }

  const languages = details.spoken_languages.map(
    (l) => l.english_name || l.name
  );

  return {
    id: details.id,
    title: details.title,
    originalTitle: details.original_title,
    overview: details.overview || "Sem sinopse disponível.",
    releaseDate: details.release_date || null,
    score: details.vote_average,
    voteCount: details.vote_count,
    runtime: details.runtime ?? null,
    status: details.status ?? null,
    posterUrl: buildPosterUrl(details.poster_path),
    genres: details.genres.map((g) => g.name),
    languages,
    isDubbed,
    hasPortugueseOverview,
    imdbUrl: details.imdb_id
      ? `https://www.imdb.com/title/${details.imdb_id}`
      : null,
    tmdbUrl: `https://www.themoviedb.org/movie/${details.id}`,
    productionStudios: details.production_companies
      .filter((c) => c.origin_country === "JP")
      .map((c) => c.name),
  };
}
