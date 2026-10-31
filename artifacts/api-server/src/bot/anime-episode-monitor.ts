import { classifyException, classifyHttpStatus, fetchError, type FetchError, type FetchResult } from "./notificacao-utils";

/** Keep stored source/ID unchanged; disambiguate only the notification lookup. */
export function animeNotificationSource(source: string, tipo?: string | null, siteUrl?: string | null): string {
  if (source !== "jikan" && source !== "tenrai") return source;
  let animeUrl = false;
  try {
    const url = new URL(siteUrl ?? "");
    animeUrl = url.hostname === "myanimelist.net" && /^\/anime\/\d+(?:\/|$)/.test(url.pathname);
  } catch { /* Unknown URLs do not identify a content category. */ }
  return tipo === "anime" || (tipo == null && animeUrl) ? "jikan-anime" : source;
}

/** Anime-only catalogs such as Kitsu use anime providers for notification fallback. */
export function isAnimeFallbackSource(source: string): boolean {
  return source === "anilist-anime" || source === "jikan-anime" || source === "kitsu";
}

export interface EpisodePage {
  data: { mal_id: number; aired: string | null }[];
  pagination: { last_visible_page: number; has_next_page: boolean };
}
type AnimeMetadata = { status: string | null; episodes: number | null };
type Dependencies = {
  request?: typeof fetch;
  now?: () => number;
  metadata: (id: number) => Promise<AnimeMetadata | null>;
  episodePage: (id: number, page: number) => Promise<EpisodePage>;
};
const result = (value: number): FetchResult => ({ value, isProxy: false });
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Counts broadcast records, never a planned season total for an ongoing anime. */
export async function fetchReleasedAnimeEpisodes(
  id: string, source: "anilist-anime" | "jikan-anime", deps: Dependencies,
): Promise<FetchResult | FetchError> {
  const numericId = Number(id);
  if (!/^[1-9]\d*$/.test(id) || !positiveInteger(numericId)) return fetchError("invalid_response");
  const now = (deps.now ?? Date.now)();
  try {
    if (source === "anilist-anime") {
      const response = await (deps.request ?? fetch)("https://graphql.anilist.co", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query ReleasedEpisodes($id: Int!, $before: Int!) {
            Media(id: $id, type: ANIME) { status episodes }
            Page(page: 1, perPage: 1) {
              airingSchedules(mediaId: $id, airingAt_lesser: $before, sort: EPISODE_DESC) {
                episode airingAt
              }
            }
          }`,
          variables: { id: numericId, before: Math.floor(now / 1000) + 1 },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return fetchError(classifyHttpStatus(response.status), response.status);
      const body = await response.json() as {
        errors?: unknown[];
        data?: { Media?: AnimeMetadata | null; Page?: { airingSchedules?: { episode: number; airingAt: number }[] } };
      };
      const media = body.data?.Media;
      if (body.errors?.length || !media) return fetchError("invalid_response");
      if (media.status === "NOT_YET_RELEASED") return result(0);
      if (media.status === "FINISHED" && positiveInteger(media.episodes)) return result(media.episodes);
      const rows = body.data?.Page?.airingSchedules;
      if (!Array.isArray(rows)) return fetchError("invalid_response");
      const released = rows.filter(row => positiveInteger(row.episode) &&
        positiveInteger(row.airingAt) && row.airingAt * 1000 <= now);
      return released.length ? result(Math.max(...released.map(row => row.episode))) : fetchError("no_data");
    }
    const media = await deps.metadata(numericId);
    if (!media) return fetchError("no_data");
    if (media.status === "NOT_YET_RELEASED") return result(0);
    if (media.status === "FINISHED" && positiveInteger(media.episodes)) return result(media.episodes);
    let page = 1;
    // Last pages hold the most recent MAL records. Null/future dates are not proof
    // of a broadcast. Bound work when a provider supplies unusable pagination.
    for (let attempt = 0; attempt < 10; attempt++) {
      const listing = await deps.episodePage(numericId, page);
      if (!Array.isArray(listing?.data) || !positiveInteger(listing.pagination?.last_visible_page) ||
          typeof listing.pagination.has_next_page !== "boolean" ||
          listing.pagination.last_visible_page < page) return fetchError("invalid_response");
      const lastPage = listing.pagination.last_visible_page;
      if (page === 1 && listing.pagination.has_next_page) {
        if (lastPage <= 1) return fetchError("invalid_response");
        page = lastPage;
        continue;
      }
      const released = listing.data.filter(row => positiveInteger(row.mal_id) &&
        typeof row.aired === "string" && Number.isFinite(Date.parse(row.aired)) && Date.parse(row.aired) <= now);
      if (released.length) return result(Math.max(...released.map(row => row.mal_id)));
      if (page <= 1) return fetchError("no_data");
      page--;
    }
    return fetchError("no_data");
  } catch (error) {
    return fetchError(classifyException(error));
  }
}
