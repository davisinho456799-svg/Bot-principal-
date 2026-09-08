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

const SOURCE_LABELS: Record<string, string> = {
  anilist: "AniList",
  "anilist-anime": "AniList",
  comick: "Comick",
  mangadex: "MangaDex",
  mangaupdates: "MangaUpdates",
  jikan: "MyAnimeList",
  "jikan-anime": "MyAnimeList",
};

const SOURCE_ICONS: Record<string, string> = {
  anilist: "🟣",
  "anilist-anime": "🟣",
  comick: "🟢",
  mangadex: "🟠",
  mangaupdates: "🔵",
  jikan: "🔴",
  "jikan-anime": "🔴",
};

function sourceSuggestion(
  title: string,
  source: keyof typeof SOURCE_LABELS,
  id: string,
): Suggestion {
  const sourceTag = `${SOURCE_ICONS[source]} ${SOURCE_LABELS[source]}`;
  const separator = " · ";
  const maxTitleLength = 100 - separator.length - sourceTag.length;
  const label = `${title.slice(0, Math.max(1, maxTitleLength)).trimEnd()}${separator}${sourceTag}`;
  return { name: label, value: `${source}:${id}` };
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

// ── Autocomplete para manga / manhwa ─────────────────────────────────────────
export async function respondAutocomplete(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cached = cache.get(query);
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

  if (comickRaw.status === "fulfilled") {
    let count = 0;
    for (const m of comickRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.title?.toLowerCase();
      if (m.title && m.slug && key && !seen.has(`comick:${key}`)) {
        seen.add(`comick:${key}`);
        suggestions.push(sourceSuggestion(m.title, "comick", m.slug));
        count++;
      }
    }
  }

  if (anilistRaw.status === "fulfilled") {
    let count = 0;
    for (const m of anilistRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = m.title.english ?? m.title.romaji ?? m.title.native ?? "";
      const key = title.toLowerCase();
      if (title && !seen.has(`anilist:${key}`)) {
        seen.add(`anilist:${key}`);
        suggestions.push(sourceSuggestion(title, "anilist", String(m.id)));
        count++;
      }
    }
  }

  if (mangadexRaw.status === "fulfilled") {
    let count = 0;
    for (const m of mangadexRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.mainTitle?.toLowerCase();
      if (m.mainTitle && key && !seen.has(`mangadex:${key}`)) {
        seen.add(`mangadex:${key}`);
        suggestions.push(sourceSuggestion(m.mainTitle, "mangadex", m.id));
        count++;
      }
    }
  }

  if (muRaw.status === "fulfilled") {
    let count = 0;
    for (const m of muRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.title?.toLowerCase();
      if (m.title && key && !seen.has(`mangaupdates:${key}`)) {
        seen.add(`mangaupdates:${key}`);
        suggestions.push(sourceSuggestion(m.title, "mangaupdates", m.id));
        count++;
      }
    }
  }

  if (jikanRaw.status === "fulfilled") {
    let count = 0;
    for (const m of jikanRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const key = m.mainTitle?.toLowerCase();
      if (m.mainTitle && key && !seen.has(`jikan:${key}`)) {
        seen.add(`jikan:${key}`);
        suggestions.push(sourceSuggestion(m.mainTitle, "jikan", String(m.malId)));
        count++;
      }
    }
  }

  cache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL });
  await interaction.respond(suggestions.slice(0, 25));
}

// ── Autocomplete para anime ───────────────────────────────────────────────────
export async function respondAutocompleteAnime(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cached = animeCache.get(query);
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

    if (anilistRaw.status === "fulfilled") {
      for (const a of anilistRaw.value) {
        const title = a.title.english ?? a.title.romaji ?? a.title.native ?? "";
        const key = title.toLowerCase();
        if (title && !seen.has(`anilist-anime:${key}`)) {
          seen.add(`anilist-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "anilist-anime", String(a.id)));
        }
      }
    }

    if (jikanRaw.status === "fulfilled") {
      for (const a of jikanRaw.value) {
        const title = a.mainTitle;
        const key = title.toLowerCase();
        if (title && !seen.has(`jikan-anime:${key}`)) {
          seen.add(`jikan-anime:${key}`);
          suggestions.push(sourceSuggestion(title, "jikan-anime", String(a.malId)));
        }
      }
    }

    suggestions.splice(25);

    animeCache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL });
    await interaction.respond(suggestions);
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
