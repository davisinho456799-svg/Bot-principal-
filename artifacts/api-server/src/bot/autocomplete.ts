import { AutocompleteInteraction } from "discord.js";
import { searchManhwa, searchAnime } from "./anilist.js";
import { searchComick } from "./comick.js";
import { searchMangaDex } from "./mangadex.js";
import { searchMangaUpdates } from "./mangaupdates.js";
import { searchJikan, searchJikanAnimeAny } from "./jikan.js";
import { searchVNDB, searchVNDBSFW } from "./vndb.js";
import { searchErogamescape } from "./erogamescape.js";

// VNDB e Erogamescape foram removidos do autocomplete de manga/manhwa:
// essas fontes cobrem visual novels e jogos eroge — não aparecem em buscas
// de manga/manhwa e só adicionam latência desnecessária.

interface Suggestion {
  name: string;
  value: string;
}

export type SourceChoice = "anilist" | "comick" | "mangadex" | "mangaupdates" | "jikan";
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
};

const SOURCE_ICONS: Record<InternalSource, string> = {
  anilist: "🟣",
  "anilist-anime": "🟣",
  comick: "🟢",
  mangadex: "🟠",
  mangaupdates: "🔵",
  jikan: "🔴",
  "jikan-anime": "🔴",
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

// ── Limite por fonte e timeout global ────────────────────────────────────────
// O Discord cancela autocompletes que não respondam em ~3s.
// Usamos 2 400ms para ter margem de sobra.
const PER_SOURCE_LIMIT = 5;
const TIMEOUT_MS       = 2_400;

/** Envolve uma Promise com um timeout. Rejeita com 'timeout' se demorar demais. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

// ── Fontes disponíveis para o título selecionado ──────────────────────────────
export async function respondSourceAutocomplete(
  interaction: AutocompleteInteraction,
  tipo: "anime" | "manga" | "manhwa",
  selectedTitle: string,
  focusedValue: string,
): Promise<void> {
  const query = selectedTitle.trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  try {
    const suggestions: Suggestion[] = [];

    if (tipo === "anime") {
      const [anilistRaw, jikanRaw] = await Promise.allSettled([
        withTimeout(searchAnime(query), TIMEOUT_MS),
        withTimeout(searchJikanAnimeAny(query), TIMEOUT_MS),
      ]);

      if (anilistRaw.status === "fulfilled") {
        const match = firstTitleMatch(
          anilistRaw.value,
          query,
          (item) => item.title.english ?? item.title.romaji ?? item.title.native,
        );
        if (match) suggestions.push(sourceChoice("anilist-anime", String(match.id)));
      }

      if (jikanRaw.status === "fulfilled") {
        const match = firstTitleMatch(jikanRaw.value, query, (item) => item.mainTitle);
        if (match) suggestions.push(sourceChoice("jikan", String(match.malId)));
      }
    } else {
      const [comickRaw, anilistRaw, mangadexRaw, muRaw, jikanRaw] =
        await Promise.allSettled([
          withTimeout(searchComick(query), TIMEOUT_MS),
          withTimeout(searchManhwa(query), TIMEOUT_MS),
          withTimeout(searchMangaDex(query), TIMEOUT_MS),
          withTimeout(searchMangaUpdates(query, "Manhwa"), TIMEOUT_MS),
          withTimeout(searchJikan(query), TIMEOUT_MS),
        ]);

      if (comickRaw.status === "fulfilled") {
        const match = firstTitleMatch(comickRaw.value, query, (item) => item.title);
        if (match?.slug) suggestions.push(sourceChoice("comick", match.slug));
      }
      if (anilistRaw.status === "fulfilled") {
        const match = firstTitleMatch(
          anilistRaw.value,
          query,
          (item) => item.title.english ?? item.title.romaji ?? item.title.native,
        );
        if (match) suggestions.push(sourceChoice("anilist", String(match.id)));
      }
      if (mangadexRaw.status === "fulfilled") {
        const match = firstTitleMatch(mangadexRaw.value, query, (item) => item.mainTitle);
        if (match) suggestions.push(sourceChoice("mangadex", match.id));
      }
      if (muRaw.status === "fulfilled") {
        const match = firstTitleMatch(muRaw.value, query, (item) => item.title);
        if (match) suggestions.push(sourceChoice("mangaupdates", match.id));
      }
      if (jikanRaw.status === "fulfilled") {
        const match = firstTitleMatch(jikanRaw.value, query, (item) => item.mainTitle);
        if (match) suggestions.push(sourceChoice("jikan", String(match.malId)));
      }
    }

    const filter = focusedValue.trim().toLowerCase();
    await interaction.respond(
      suggestions
        .filter((suggestion) => !filter || suggestion.name.toLowerCase().includes(filter))
        .slice(0, 25),
    );
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
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cacheKey = `${plainValue ? "plain" : "source"}:${sourceFilter ?? "all"}:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    await interaction.respond(cached.results.slice(0, 25));
    return;
  }

  // Comick é a fonte principal. As demais complementam a busca sem bloquear
  // o autocomplete quando alguma API estiver indisponível.
  const [comickRaw, anilistRaw, mangadexRaw, muRaw, jikanRaw] =
    await Promise.allSettled([
      withTimeout(searchComick(query),        TIMEOUT_MS),
      withTimeout(searchManhwa(query),       TIMEOUT_MS),
      withTimeout(searchMangaDex(query),      TIMEOUT_MS),
      withTimeout(searchMangaUpdates(query, "Manhwa"),  TIMEOUT_MS),
      withTimeout(searchJikan(query),         TIMEOUT_MS),
    ]);

  // A mesma obra pode existir em várias fontes. Não deduplicar apenas pelo
  // título: a fonte faz parte da escolha da assinatura.
  const seen        = new Set<string>();
  const suggestions: Suggestion[] = [];

  if (comickRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "comick")) {
    let count = 0;
    for (const m of comickRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.title?.toLowerCase();
      if (m.title && m.slug && key && !seen.has(`comick:${key}`)) {
        seen.add(`comick:${key}`);
        suggestions.push(sourceSuggestion(m.title, "comick", m.slug, plainValue));
        count++;
      }
    }
  }

  if (anilistRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "anilist")) {
    let count = 0;
    for (const m of anilistRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = m.title.english ?? m.title.romaji ?? m.title.native ?? "";
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
      const key = m.mainTitle?.toLowerCase();
      if (m.mainTitle && key && !seen.has(`mangadex:${key}`)) {
        seen.add(`mangadex:${key}`);
        suggestions.push(sourceSuggestion(m.mainTitle, "mangadex", m.id, plainValue));
        count++;
      }
    }
  }

  if (muRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "mangaupdates")) {
    let count = 0;
    for (const m of muRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.title?.toLowerCase();
      if (m.title && key && !seen.has(`mangaupdates:${key}`)) {
        seen.add(`mangaupdates:${key}`);
        suggestions.push(sourceSuggestion(m.title, "mangaupdates", m.id, plainValue));
        count++;
      }
    }
  }

  if (jikanRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "jikan")) {
    let count = 0;
    for (const m of jikanRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.mainTitle?.toLowerCase();
      if (m.mainTitle && key && !seen.has(`jikan:${key}`)) {
        seen.add(`jikan:${key}`);
        suggestions.push(sourceSuggestion(m.mainTitle, "jikan", String(m.malId), plainValue));
        count++;
      }
    }
  }

  const finalSuggestions = plainValue ? dedupeTitleSuggestions(suggestions) : suggestions;
  cache.set(cacheKey, { results: finalSuggestions, expires: Date.now() + CACHE_TTL });
  await interaction.respond(finalSuggestions.slice(0, 25));
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
    const [anilistRaw, jikanRaw] = await Promise.allSettled([
      withTimeout(searchAnime(query), TIMEOUT_MS),
      withTimeout(searchJikanAnimeAny(query), TIMEOUT_MS),
    ]);
    const suggestions: Suggestion[] = [];
    const seen = new Set<string>();

    if (anilistRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "anilist")) {
      for (const a of anilistRaw.value) {
        const title = a.title.english ?? a.title.romaji ?? a.title.native ?? "";
        const key = title.toLowerCase();
        if (title && !seen.has(`anilist-anime:${key}`)) {
          seen.add(`anilist-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "anilist-anime", String(a.id), plainValue));
        }
      }
    }

    if (jikanRaw.status === "fulfilled" && (!sourceFilter || sourceFilter === "jikan")) {
      for (const a of jikanRaw.value) {
        const title = a.mainTitle;
        const key = title.toLowerCase();
        if (title && !seen.has(`jikan-anime:${key}`)) {
          seen.add(`jikan-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "jikan-anime", String(a.malId), plainValue));
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
