import type { AutocompleteInteraction } from "discord.js";
import { logger } from "../lib/logger.js";

type Kind = "anime" | "manga";
type Provider = Kind | "tenrai";
type Choice = { name: string; value: string };
type CacheEntry = { choices: Choice[]; expires: number; aliases: Map<string, string[]> };
type SourceResult = { choices: Choice[]; aliases: Map<string, string[]>; failed: boolean };
const compactTitle = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const QUERY = `query TitleSuggestions($search: String!) {
  Page(perPage: 10) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id title { english romaji native } synonyms
    }
  }
}`;

/**
 * Suggestions have their own small request budget: never fan out into the
 * full search/monitor providers. Anime uses only AniList and Tenrai, with
 * independent cooldowns and a fast-first response. Manual titles remain supported.
 */
export function createTitleAutocomplete({
  request = fetch,
  now = Date.now,
  timeoutMs = 1_200,
  onFailure = (source: Provider, reason: string) =>
    logger.warn({ source, reason }, "Fonte de autocomplete de títulos indisponível"),
} = {}) {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<Choice[]>>();
  const sources = {
    anime: { busy: false, nextRequest: 0 },
    tenrai: { busy: false, nextRequest: 0 },
    manga: { busy: false, nextRequest: 0 },
  };

  function remember(key: string, choices: Choice[], ttl: number, aliases = new Map<string, string[]>()) {
    cache.delete(key);
    cache.set(key, { choices, expires: now() + ttl, aliases });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
  }

  function fromPrefix(kind: Kind, query: string): Choice[] {
    const needle = compactTitle(query);
    if (!needle) return [];
    const entries = [...cache.entries()].filter(([key, entry]) =>
      key.startsWith(`${kind}:`) && entry.expires > now() &&
      needle.startsWith(compactTitle(key.slice(kind.length + 1))),
    ).sort(([a], [b]) => b.length - a.length);
    for (const [, entry] of entries) {
      const matches = entry.choices.filter(choice =>
        (entry.aliases.get(choice.value) ?? [compactTitle(choice.name)])
          .some(alias => alias.includes(needle)),
      );
      if (matches.length) return matches;
    }
    return [];
  }

  async function loadSource(kind: Provider, query: string): Promise<SourceResult> {
    const state = sources[kind];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aliases = new Map<string, string[]>();
    try {
      const operation = async () => {
        const params = new URLSearchParams({
          title: query, limit: "10", "originalLanguage[]": "ja",
          "order[relevance]": "desc", "contentRating[]": "safe",
        });
        params.append("contentRating[]", "suggestive");
        const tenraiParams = new URLSearchParams({ q: query, limit: "10" });
        const response = await request(
          kind === "anime"
            ? "https://graphql.anilist.co"
            : kind === "tenrai"
              ? `https://api.tenrai.org/v1/anime?${tenraiParams}`
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
            ? [titles?.english, titles?.romaji, titles?.native,
              ...(Array.isArray(row?.synonyms) ? row.synonyms : [])]
            : kind === "tenrai"
              ? [row?.title, row?.title_english, row?.title_japanese,
                ...(Array.isArray(row?.title_synonyms) ? row.title_synonyms : []),
                ...(Array.isArray(row?.titles) ? row.titles.map((t: { title?: unknown }) => t?.title) : [])]
              : [titles?.en, titles?.["ja-ro"], titles?.["pt-br"], titles?.ja,
                ...Object.values(titles ?? {})];
          const validTitles = candidates.filter((t): t is string => typeof t === "string" && Boolean(t.trim()));
          const title = (kind !== "manga" && validTitles.find(t => compactTitle(t).includes(compactTitle(query))))
            || validTitles[0];
          const id = kind === "tenrai" ? row?.mal_id : row?.id;
          const validId = kind !== "manga"
            ? Number.isSafeInteger(id) && id > 0
            : typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
          if (!title || !validId) continue;
          const name = (title as string).trim().replace(/\s+/g, " ").slice(0, 100);
          const identity = name.normalize("NFKC").toLowerCase();
          if (seen.has(identity) || seenIds.has(String(id))) continue;
          seen.add(identity);
          seenIds.add(String(id));
          const value = `${kind === "anime" ? "anilist-anime" : kind === "tenrai" ? "tenrai" : "mangadex"}:${id}`;
          aliases.set(value, candidates.filter((t): t is string => typeof t === "string")
            .map(compactTitle));
          choices.push({ name, value });
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
      return { choices, aliases, failed: false };
    } catch (error) {
      state.nextRequest = Math.max(state.nextRequest, now() + 10_000);
      onFailure(kind, error instanceof Error ? error.message : "SOURCE_FAILED");
      return { choices: [], aliases, failed: true };
    } finally {
      if (timer) clearTimeout(timer);
      state.busy = false;
    }
  }

  function mergeResults(results: SourceResult[]): SourceResult {
    const choices: Choice[] = [];
    const aliases = new Map<string, string[]>();
    const owners = new Map<string, Choice>();
    for (const result of results) {
      for (const choice of result.choices) {
        const names = result.aliases.get(choice.value) ?? [compactTitle(choice.name)];
        const duplicate = names.map(name => owners.get(name)).find(Boolean);
        if (duplicate) {
          aliases.set(duplicate.value, [...new Set([...(aliases.get(duplicate.value) ?? []), ...names])]);
          for (const name of names) owners.set(name, duplicate);
          continue;
        }
        choices.push(choice);
        aliases.set(choice.value, names);
        for (const name of names) owners.set(name, choice);
      }
    }
    return { choices: choices.slice(0, 20), aliases, failed: results.some(result => result.failed) };
  }

  function load(providers: Provider[], query: string, key: string, allProviders: Provider[]): Promise<Choice[]> {
    const results = new Map<Provider, SourceResult>();
    let remaining = providers.length;
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let respond!: (choices: Choice[]) => void;
    const response = new Promise<Choice[]>(resolve => { respond = resolve; });
    const combined = () => mergeResults(providers.flatMap(provider => {
      const result = results.get(provider);
      return result ? [result] : [];
    }));
    const finish = () => {
      if (answered) return;
      answered = true;
      if (timer) clearTimeout(timer);
      respond(combined().choices);
    };
    for (const provider of providers) {
      const state = sources[provider];
      state.busy = true;
      state.nextRequest = now() + 3_000;
      void loadSource(provider, query).then(result => {
        results.set(provider, result);
        remaining--;
        const merged = combined();
        // Later results enrich the cache, not a second Discord acknowledgement.
        if (merged.choices.length || remaining === 0) {
          const emptyTtl = Math.min(merged.failed ? 10_000 : 15_000,
            ...allProviders.filter(source => !providers.includes(source))
              .map(source => Math.max(0, sources[source].nextRequest - now())));
          // An empty fallback must not hide a source once its cooldown ends.
          remember(key, merged.choices, merged.choices.length ? 60_000 : emptyTtl, merged.aliases);
        }
        if (remaining === 0) {
          pending.delete(key);
          finish();
        } else if (merged.choices.length && !answered && !timer) {
          // Give another fast source a small merge window, never its full timeout.
          timer = setTimeout(finish, 80);
        }
      });
    }
    return response;
  }

  return async (kind: Kind, input: string): Promise<Choice[]> => {
    const query = input.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 3 || query.length > 100) return [];
    const key = `${kind}:${query}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.choices.length
      ? cached.choices : fromPrefix(kind, query);
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    const providers: Provider[] = kind === "anime" ? ["anime", "tenrai"] : ["manga"];
    const available = providers.filter(provider =>
      !sources[provider].busy && now() >= sources[provider].nextRequest,
    );
    if (!available.length) {
      const matches = fromPrefix(kind, query);
      if (matches.length) return matches;
      // Continuing to type must not clear suggestions merely because the
      // shorter query is still loading. Share it and filter its real results.
      for (const [pendingKey, promise] of pending) {
        if (pendingKey.startsWith(`${kind}:`) &&
            compactTitle(query).startsWith(compactTitle(pendingKey.slice(kind.length + 1)))) {
          await promise;
          return fromPrefix(kind, query);
        }
      }
      return [];
    }
    const result = load(available, query, key, providers);
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