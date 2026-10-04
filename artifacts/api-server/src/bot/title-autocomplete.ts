import type { AutocompleteInteraction } from "discord.js";
import { logger } from "../lib/logger.js";

type Kind = "anime" | "manga";
type Choice = { name: string; value: string };
type CacheEntry = { choices: Choice[]; expires: number };
const QUERY = `query TitleSuggestions($search: String!) {
  Page(perPage: 10) {
    media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
      id title { english romaji native }
    }
  }
}`;

/**
 * Suggestions have their own small request budget: never fan out into the
 * full search/monitor providers. A busy or unavailable source returns no choices;
 * entering a title manually remains supported by the existing command.
 */
export function createTitleAutocomplete({
  request = fetch,
  now = Date.now,
  timeoutMs = 1_200,
  onFailure = (source: Kind, reason: string) =>
    logger.warn({ source, reason }, "Fonte de autocomplete de títulos indisponível"),
} = {}) {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<Choice[]>>();
  const sources = {
    anime: { busy: false, nextRequest: 0 },
    manga: { busy: false, nextRequest: 0 },
  };

  function remember(key: string, choices: Choice[], ttl: number) {
    cache.delete(key);
    cache.set(key, { choices, expires: now() + ttl });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
  }

  async function load(kind: Kind, query: string, key: string): Promise<Choice[]> {
    const state = sources[kind];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = async () => {
        const params = new URLSearchParams({
          title: query, limit: "10", "originalLanguage[]": "ja",
          "order[relevance]": "desc", "contentRating[]": "safe",
        });
        params.append("contentRating[]", "suggestive");
        const response = await request(
          kind === "anime"
            ? "https://graphql.anilist.co"
            : `https://api.mangadex.org/manga?${params}`,
          {
            signal: controller.signal,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            ...(kind === "anime" ? {
              method: "POST",
              body: JSON.stringify({ query: QUERY, variables: { search: query } }),
            } : {}),
          },
        );
        if (!response.ok) {
          const retry = response.headers.get("retry-after") ?? "";
          const delay = /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1_000 : Date.parse(retry) - now();
          state.nextRequest = Math.max(state.nextRequest, now() + (
            response.status === 429
              ? Math.max(30_000, Number.isFinite(delay) ? delay : 30_000)
              : 10_000
          ));
          throw new Error(`HTTP_${response.status}`);
        }
        const body = await response.json();
        const rows = kind === "anime" ? body.data?.Page?.media : body.data;
        if (!Array.isArray(rows) || body.errors?.length ||
            (kind === "manga" && body.result !== "ok")) {
          throw new Error("INVALID_RESPONSE");
        }
        const choices: Choice[] = [];
        const seen = new Set<string>();
        const seenIds = new Set<string>();
        for (const row of rows) {
          const titles = kind === "anime"
            ? row?.title : row?.attributes?.title;
          const candidates = kind === "anime"
            ? [titles?.english, titles?.romaji, titles?.native]
            : [titles?.en, titles?.["ja-ro"], titles?.["pt-br"], titles?.ja,
              ...Object.values(titles ?? {})];
          const title = candidates.find(t => typeof t === "string" && t.trim());
          const id = row?.id;
          const validId = kind === "anime"
            ? Number.isSafeInteger(id) && id > 0
            : typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
          if (!title || !validId) continue;
          const name = (title as string).trim().replace(/\s+/g, " ").slice(0, 100);
          const identity = name.normalize("NFKC").toLowerCase();
          if (seen.has(identity) || seenIds.has(String(id))) continue;
          seen.add(identity);
          seenIds.add(String(id));
          choices.push({ name, value: `${kind === "anime" ? "anilist-anime" : "mangadex"}:${id}` });
          if (choices.length === 10) break;
        }
        return choices;
      };
      const choices = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
      remember(key, choices, choices.length ? 60_000 : 15_000);
      return choices;
    } catch (error) {
      state.nextRequest = Math.max(state.nextRequest, now() + 10_000);
      remember(key, [], 10_000);
      onFailure(kind, error instanceof Error ? error.message : "SOURCE_FAILED");
      return [];
    } finally {
      if (timer) clearTimeout(timer);
      state.busy = false;
      pending.delete(key);
    }
  }

  return async (kind: Kind, input: string): Promise<Choice[]> => {
    const query = input.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 3 || query.length > 100) return [];
    const key = `${kind}:${query}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.choices;
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    const state = sources[kind];
    if (state.busy || now() < state.nextRequest) return [];
    state.busy = true;
    state.nextRequest = now() + 3_000;
    const result = load(kind, query, key);
    pending.set(key, result);
    return result;
  };
}

const suggestTitles = createTitleAutocomplete();

export async function respondTitleAutocomplete(
  interaction: AutocompleteInteraction,
  kind: Kind,
  suggest = suggestTitles,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const choices = focused.name === "titulo" && typeof focused.value === "string"
    ? await suggest(kind, focused.value) : [];
  // Leave acknowledgement failures to the existing router; never respond twice.
  await interaction.respond(choices);
}