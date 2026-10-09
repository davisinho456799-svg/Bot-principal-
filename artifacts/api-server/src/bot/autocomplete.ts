import { AutocompleteInteraction } from "discord.js";
import { searchManhwa, searchAnime } from "./anilist.js";
import { searchComick } from "./comick.js";
import { searchMangaDex } from "./mangadex.js";
import { searchMangaUpdates } from "./mangaupdates.js";
import { searchJikan, searchJikanAnimeAny } from "./jikan.js";
import { searchVNDB, searchVNDBSFW } from "./vndb.js";
import { searchErogamescape } from "./erogamescape.js";
import { searchTenraiAnime, searchTenraiManga, titleOfTenrai } from "./tenrai-fallback.js";
import { searchKitsu } from "./kitsu.js";

// VNDB e Erogamescape foram removidos do autocomplete de manga/manhwa:
// essas fontes cobrem visual novels e jogos eroge — não aparecem em buscas
// de manga/manhwa e só adicionam latência desnecessária.

interface Suggestion {
  name: string;
  value: string;
}

export type SourceChoice = "anilist" | "comick" | "mangadex" | "mangaupdates" | "jikan" | "tenrai" | "kitsu";
export type MangaUpdatesKind = "Manga" | "Manhwa";
type InternalSource = SourceChoice | "anilist-anime" | "jikan-anime";

function sourceSuggestion(
  title: string,
  source: InternalSource,
  id: string,
  plainValue = false,
): Suggestion {
  return {
    name: title.slice(0, 100),
    value: plainValue ? title.slice(0, 100) : `${source}:${id}`,
  };
}

const SOURCE_LABELS: Record<InternalSource, string> = {
  anilist: "AniList",
  "anilist-anime": "AniList",
  comick: "Comick",
  mangadex: "MangaDex",
  mangaupdates: "MangaUpdates",
  jikan: "MyAnimeList",
  "jikan-anime": "MyAnimeList",
  tenrai: "Tenrai",
  kitsu: "Kitsu",
};

const SOURCE_ICONS: Record<InternalSource, string> = {
  anilist: "🟣",
  "anilist-anime": "🟣",
  comick: "🟢",
  mangadex: "🟠",
  mangaupdates: "🔵",
  jikan: "🔴",
  "jikan-anime": "🔴",
  tenrai: "🟦",
  kitsu: "💠",
};

function dedupeTitleSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = suggestion.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTitleForLookup(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, "");
}

function titleMatches(query: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const normalizedQuery = normalizeTitleForLookup(query);
  const normalizedCandidate = normalizeTitleForLookup(candidate);
  return Boolean(
    normalizedQuery &&
      normalizedCandidate &&
      (normalizedQuery === normalizedCandidate ||
        normalizedQuery.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedQuery)),
  );
}

function sourceChoice(source: InternalSource, id: string): Suggestion {
  return {
    name: `${SOURCE_ICONS[source]} ${SOURCE_LABELS[source]}`,
    value: `${source}:${id}`,
  };
}

function firstTitleMatch<T>(
  results: T[],
  query: string,
  getTitle: (result: T) => string | null | undefined,
): T | null {
  return results.find((result) => titleMatches(query, getTitle(result))) ?? null;
}

// ── Cache em memória (30s TTL) ───────────────────────────────────────────────
const cache      = new Map<string, { results: Suggestion[]; expires: number }>();
const animeCache = new Map<string, { results: Suggestion[]; expires: number }>();
const CACHE_TTL  = 30_000;
const vnCache     = new Map<string, { results: Suggestion[]; expires: number }>();
const vn18Cache   = new Map<string, { results: Suggestion[]; expires: number }>();
const erogeCache  = new Map<string, { results: Suggestion[]; expires: number }>();
const sourceCache = new Map<string, { results: Suggestion[]; expires: number }>();

// ── Limite por fonte e timeout global ────────────────────────────────────────
// O Discord cancela autocompletes que não respondam em ~3s.
// Mantém margem para debounce e pacing do router antes do prazo do Discord.
const PER_SOURCE_LIMIT = 5;
const TIMEOUT_MS       = 1_000;

/** Envolve uma Promise com um timeout. Rejeita com 'timeout' se demorar demais. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      { timer = setTimeout(() => reject(new Error("timeout")), ms); }
    ),
  ]).finally(() => clearTimeout(timer));
}

// ── Fontes disponíveis para o título selecionado ──────────────────────────────
export async function respondSourceAutocomplete(
  interaction: AutocompleteInteraction,
  tipo: "anime" | "manga" | "manhwa",
  selectedTitle: string,
  focusedValue: string,
  mangaUpdatesKind: MangaUpdatesKind = "Manhwa",
): Promise<void> {
  const query = selectedTitle.trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }
  const cacheKey = `${tipo}:${mangaUpdatesKind}:${query.toLowerCase()}`;
  const cached = sourceCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    const filter = focusedValue.trim().toLowerCase();
    await interaction.respond(
      cached.results.filter(item => !filter || item.name.toLowerCase().includes(filter)).slice(0, 25),
    );
    return;
  }

  try {
    const suggestions: Suggestion[] = [];

    if (tipo === "anime") {
      const [anilistRaw, jikanRaw, tenraiRaw, kitsuRaw] = await Promise.allSettled([
        withTimeout(searchAnime(query), TIMEOUT_MS),
        withTimeout(searchJikanAnimeAny(query), TIMEOUT_MS),
        withTimeout(searchTenraiAnime(query), TIMEOUT_MS),
        withTimeout(searchKitsu(query), TIMEOUT_MS),
      ]);

      if (anilistRaw.status === "fulfilled") {
        const match = firstTitleMatch(
          anilistRaw.value,
          query,
          (item) => item?.title?.english ?? item?.title?.romaji ?? item?.title?.native,
        );
        if (match) suggestions.push(sourceChoice("anilist-anime", String(match.id)));
      }

      if (jikanRaw.status === "fulfilled") {
        const match = firstTitleMatch(jikanRaw.value, query, (item) => item?.mainTitle);
        if (match) suggestions.push(sourceChoice("jikan", String(match.malId)));
      }

      if (tenraiRaw.status === "fulfilled") {
        const match = firstTitleMatch(tenraiRaw.value, query, (item) => titleOfTenrai(item));
        if (match && typeof match.mal_id === "number" && Number.isSafeInteger(match.mal_id) && match.mal_id > 0) {
          suggestions.push(sourceChoice("tenrai", String(match.mal_id)));
        }
      }

      if (kitsuRaw.status === "fulfilled") {
        const match = kitsuRaw.value.find((item) =>
          [item?.mainTitle, item?.englishTitle, ...(item?.synonyms ?? [])]
            .some((title) => titleMatches(query, title)),
        );
        if (match?.kitsuId) suggestions.push(sourceChoice("kitsu", match.kitsuId));
      }
    } else {
      const [comickRaw, anilistRaw, mangadexRaw, muRaw, jikanRaw, tenraiRaw] =
        await Promise.allSettled([
          withTimeout(searchComick(query), TIMEOUT_MS),
          withTimeout(searchManhwa(query), TIMEOUT_MS),
          withTimeout(searchMangaDex(query), TIMEOUT_MS),
          withTimeout(searchMangaUpdates(query, mangaUpdatesKind), TIMEOUT_MS),
          withTimeout(searchJikan(query), TIMEOUT_MS),
          withTimeout(searchTenraiManga(query, mangaUpdatesKind === "Manga" ? "manga" : "manhwa"), TIMEOUT_MS),
        ]);

      if (comickRaw.status === "fulfilled") {
        const match = firstTitleMatch(comickRaw.value, query, (item) => item?.title);
        if (match?.slug) suggestions.push(sourceChoice("comick", match.slug));
      }
      if (anilistRaw.status === "fulfilled") {
        const match = firstTitleMatch(
          anilistRaw.value,
          query,
          (item) => item?.title?.english ?? item?.title?.romaji ?? item?.title?.native,
        );
        if (match) suggestions.push(sourceChoice("anilist", String(match.id)));
      }
      if (mangadexRaw.status === "fulfilled") {
        const match = firstTitleMatch(mangadexRaw.value, query, (item) => item?.mainTitle);
        if (match) suggestions.push(sourceChoice("mangadex", match.id));
      }
      if (muRaw.status === "fulfilled") {
        const match = firstTitleMatch(muRaw.value, query, (item) => item?.title);
        if (match) suggestions.push(sourceChoice("mangaupdates", match.id));
      }
      if (jikanRaw.status === "fulfilled") {
        const match = firstTitleMatch(jikanRaw.value, query, (item) => item?.mainTitle);
        if (match) suggestions.push(sourceChoice("jikan", String(match.malId)));
      }
      if (tenraiRaw.status === "fulfilled") {
        const match = firstTitleMatch(tenraiRaw.value, query, (item) => titleOfTenrai(item));
        if (match && typeof match.mal_id === "number" && Number.isSafeInteger(match.mal_id) && match.mal_id > 0) {
          suggestions.push(sourceChoice("tenrai", String(match.mal_id)));
        }
      }
    }

    const filter = focusedValue.trim().toLowerCase();
    const results = suggestions
      .filter((suggestion) => !filter || suggestion.name.toLowerCase().includes(filter))
      .slice(0, 25);
    sourceCache.set(cacheKey, { results: suggestions.slice(0, 25), expires: Date.now() + CACHE_TTL });
    if (sourceCache.size > 128) sourceCache.delete(sourceCache.keys().next().value!);
    await interaction.respond(results);
  } catch {
    await interaction.respond([]);
  }
}

// ── Autocomplete para manga / manhwa ─────────────────────────────────────────
export async function respondAutocomplete(
  interaction: AutocompleteInteraction,
  focusedValue: string,
  sourceFilter: SourceChoice | null = null,
  plainValue = false,
  mangaUpdatesKind: MangaUpdatesKind = "Manhwa",
  includeTenrai = false,
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cacheKey = `${plainValue ? "plain" : "source"}:${sourceFilter ?? "all"}:${mangaUpdatesKind}:${includeTenrai}:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    await interaction.respond(cached.results.slice(0, 25));
    return;
  }

  // Comick é a fonte principal. As demais complementam a busca sem bloquear
  // o autocomplete quando alguma API estiver indisponível.
  try {
  const [comickRaw, anilistRaw, mangadexRaw, muRaw, jikanRaw, tenraiRaw] =
    await Promise.allSettled([
      withTimeout(searchComick(query),        TIMEOUT_MS),
      withTimeout(searchManhwa(query),       TIMEOUT_MS),
      withTimeout(searchMangaDex(query),      TIMEOUT_MS),
      withTimeout(searchMangaUpdates(query, mangaUpdatesKind), TIMEOUT_MS),
      withTimeout(searchJikan(query),         TIMEOUT_MS),
      includeTenrai
        ? withTimeout(searchTenraiManga(query, mangaUpdatesKind === "Manga" ? "manga" : "manhwa"), TIMEOUT_MS)
        : Promise.resolve([]),
    ]);

  // A mesma obra pode existir em várias fontes. Não deduplicar apenas pelo
  // título: a fonte faz parte da escolha da assinatura.
  const seen        = new Set<string>();
  const suggestions: Suggestion[] = [];

  if (comickRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "comick")) {
    let count = 0;
    for (const m of comickRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = typeof m?.title === "string" ? m.title : "";
      const key = title.toLowerCase();
      if (title && m.slug && key && !seen.has(`comick:${key}`)) {
        seen.add(`comick:${key}`);
        suggestions.push(sourceSuggestion(title, "comick", m.slug, plainValue));
        count++;
      }
    }
  }

  if (anilistRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "anilist")) {
    let count = 0;
    for (const m of anilistRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = m?.title?.english ?? m?.title?.romaji ?? m?.title?.native ?? "";
      const key = title.toLowerCase();
      if (title && !seen.has(`anilist:${key}`)) {
        seen.add(`anilist:${key}`);
        suggestions.push(sourceSuggestion(title, "anilist", String(m.id), plainValue));
        count++;
      }
    }
  }

  if (mangadexRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "mangadex")) {
    let count = 0;
    for (const m of mangadexRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = typeof m?.mainTitle === "string" ? m.mainTitle : "";
      const key = title.toLowerCase();
      if (title && key && !seen.has(`mangadex:${key}`)) {
        seen.add(`mangadex:${key}`);
        suggestions.push(sourceSuggestion(title, "mangadex", m.id, plainValue));
        count++;
      }
    }
  }

  if (muRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "mangaupdates")) {
    let count = 0;
    for (const m of muRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = typeof m?.title === "string" ? m.title : "";
      const key = title.toLowerCase();
      if (title && key && !seen.has(`mangaupdates:${key}`)) {
        seen.add(`mangaupdates:${key}`);
        suggestions.push(sourceSuggestion(title, "mangaupdates", m.id, plainValue));
        count++;
      }
    }
  }

  if (jikanRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "jikan")) {
    let count = 0;
    for (const m of jikanRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = typeof m?.mainTitle === "string" ? m.mainTitle : "";
      const key = title.toLowerCase();
      if (title && key && !seen.has(`jikan:${key}`)) {
        seen.add(`jikan:${key}`);
        suggestions.push(sourceSuggestion(title, "jikan", String(m.malId), plainValue));
        count++;
      }
    }
  }

  if (includeTenrai && tenraiRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "tenrai")) {
    let count = 0;
    for (const m of tenraiRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = titleOfTenrai(m);
      const key = title.toLowerCase();
      if (title && typeof m?.mal_id === "number" && Number.isSafeInteger(m.mal_id) && m.mal_id > 0 &&
          !seen.has(`tenrai:${key}`)) {
        seen.add(`tenrai:${key}`);
        suggestions.push(sourceSuggestion(title, "tenrai", String(m.mal_id), plainValue));
        count++;
      }
    }
  }

  const finalSuggestions = plainValue ? dedupeTitleSuggestions(suggestions) : suggestions;
  cache.set(cacheKey, { results: finalSuggestions, expires: Date.now() + CACHE_TTL });
  await interaction.respond(finalSuggestions.slice(0, 25));
  } catch {
    await interaction.respond([]);
  }
}

// ── Autocomplete para anime ───────────────────────────────────────────────────
export async function respondAutocompleteAnime(
  interaction: AutocompleteInteraction,
  focusedValue: string,
  sourceFilter: SourceChoice | null = null,
  plainValue = false,
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cacheKey = `${plainValue ? "plain" : "source"}:${sourceFilter ?? "all"}:${query}`;
  const cached = animeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    await interaction.respond(cached.results.slice(0, 25));
    return;
  }

  try {
    // AniList pode estar temporariamente indisponível. O MAL/Jikan já é
    // suportado pelo rastreador de episódios e aparece como fonte alternativa.
    const [anilistRaw, jikanRaw, tenraiRaw, kitsuRaw] = await Promise.allSettled([
      withTimeout(searchAnime(query), TIMEOUT_MS),
      withTimeout(searchJikanAnimeAny(query), TIMEOUT_MS),
      withTimeout(searchTenraiAnime(query), TIMEOUT_MS),
      withTimeout(searchKitsu(query), TIMEOUT_MS),
    ]);
    const suggestions: Suggestion[] = [];
    const seen = new Set<string>();

    if (anilistRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "anilist")) {
      for (const a of anilistRaw.value) {
        const title = a?.title?.english ?? a?.title?.romaji ?? a?.title?.native ?? "";
        const key = title.toLowerCase();
        if (title && !seen.has(`anilist-anime:${key}`)) {
          seen.add(`anilist-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "anilist-anime", String(a.id), plainValue));
        }
      }
    }

    if (jikanRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "jikan")) {
      for (const a of jikanRaw.value) {
        const title = typeof a?.mainTitle === "string" ? a.mainTitle : "";
        const key = title.toLowerCase();
        if (title && !seen.has(`jikan-anime:${key}`)) {
          seen.add(`jikan-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "jikan-anime", String(a.malId), plainValue));
        }
      }
    }

    if (tenraiRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "tenrai")) {
      let count = 0;
      for (const a of tenraiRaw.value) {
        if (count >= PER_SOURCE_LIMIT) break;
        const title = titleOfTenrai(a);
        const key = title.toLowerCase();
        if (title && typeof a?.mal_id === "number" && Number.isSafeInteger(a.mal_id) && a.mal_id > 0 &&
            !seen.has(`tenrai:${key}`)) {
          seen.add(`tenrai:${key}`);
          suggestions.push(sourceSuggestion(title, "tenrai", String(a.mal_id), plainValue));
          count++;
        }
      }
    }

    if (kitsuRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "kitsu")) {
      let count = 0;
      for (const a of kitsuRaw.value) {
        if (count >= PER_SOURCE_LIMIT) break;
        const title = typeof a?.mainTitle === "string" ? a.mainTitle : "";
        const key = title.toLowerCase();
        if (title && a.kitsuId && !seen.has(`kitsu:${key}`)) {
          seen.add(`kitsu:${key}`);
          suggestions.push(sourceSuggestion(title, "kitsu", a.kitsuId, plainValue));
          count++;
        }
      }
    }

    suggestions.splice(25);

    const finalSuggestions = plainValue ? dedupeTitleSuggestions(suggestions) : suggestions;
    animeCache.set(cacheKey, { results: finalSuggestions, expires: Date.now() + CACHE_TTL });
    await interaction.respond(finalSuggestions);
  } catch {
    await interaction.respond([]);
  }
}

// ── Autocomplete para VN (SFW) ────────────────────────────────────────────────
export async function respondAutocompleteVN(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();
  if (query.length < 2) { await interaction.respond([]); return; }
  const cached = vnCache.get(query);
  if (cached && cached.expires > Date.now()) { await interaction.respond(cached.results.slice(0, 25)); return; }
  try {
    const results = await withTimeout(searchVNDBSFW(query), TIMEOUT_MS);
    const suggestions: Suggestion[] = results
      .map((vn) => ({ name: vn.mainTitle.slice(0, 100), value: `vndb:${vn.vnId}` }))
      .slice(0, 25);
    vnCache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL });
    await interaction.respond(suggestions);
  } catch { await interaction.respond([]); }
}

// ── Autocomplete para VN +18 ──────────────────────────────────────────────────
export async function respondAutocompleteVN18(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();
  if (query.length < 2) { await interaction.respond([]); return; }
  const cached = vn18Cache.get(query);
  if (cached && cached.expires > Date.now()) { await interaction.respond(cached.results.slice(0, 25)); return; }
  try {
    const results = await withTimeout(searchVNDB(query), TIMEOUT_MS);
    const suggestions: Suggestion[] = results
      .map((vn) => ({ name: vn.mainTitle.slice(0, 100), value: `vndb:${vn.vnId}` }))
      .slice(0, 25);
    vn18Cache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL });
    await interaction.respond(suggestions);
  } catch { await interaction.respond([]); }
}

// ── Autocomplete para Eroge (Erogamescape) ────────────────────────────────────
export async function respondAutocompleteEroge(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();
  if (query.length < 2) { await interaction.respond([]); return; }
  const cached = erogeCache.get(query);
  if (cached && cached.expires > Date.now()) { await interaction.respond(cached.results.slice(0, 25)); return; }
  try {
    const results = await withTimeout(searchErogamescape(query), TIMEOUT_MS);
    const suggestions: Suggestion[] = results
      .map((g) => ({ name: g.mainTitle.slice(0, 100), value: `erogamescape:${g.gameId}` }))
      .slice(0, 25);
    erogeCache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL });
    await interaction.respond(suggestions);
  } catch { await interaction.respond([]); }
}
