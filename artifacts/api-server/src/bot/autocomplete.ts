import { AutocompleteInteraction } from "discord.js";
import { searchManhwa, searchAnime } from "./anilist.js";
import { searchComick } from "./comick.js";
import { searchMangaDex } from "./mangadex.js";
import { searchMangaUpdates } from "./mangaupdates.js";
import { searchJikan } from "./jikan.js";
import { searchVNDB, searchVNDBSFW } from "./vndb.js";
import { searchErogamescape } from "./erogamescape.js";

// VNDB e Erogamescape foram removidos do autocomplete de manga/manhwa:
// essas fontes cobrem visual novels e jogos eroge — não aparecem em buscas
// de manga/manhwa e só adicionam latência desnecessária.

interface Suggestion {
  name: string;
  value: string;
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

  const seen        = new Set<string>();
  const suggestions: Suggestion[] = [];

  if (comickRaw.status === "fulfilled") {
    let count = 0;
    for (const m of comickRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      if (m.title && !seen.has(m.title.toLowerCase())) {
        seen.add(m.title.toLowerCase());
        suggestions.push({ name: m.title.slice(0, 100), value: `comick:${m.slug}` });
        count++;
      }
    }
  }

  if (anilistRaw.status === "fulfilled") {
    let count = 0;
    for (const m of anilistRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      const title = m.title.english ?? m.title.romaji ?? m.title.native ?? "";
      if (title && !seen.has(title.toLowerCase())) {
        seen.add(title.toLowerCase());
        suggestions.push({ name: title.slice(0, 100), value: `anilist:${m.id}` });
        count++;
      }
    }
  }

  if (mangadexRaw.status === "fulfilled") {
    let count = 0;
    for (const m of mangadexRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      if (m.mainTitle && !seen.has(m.mainTitle.toLowerCase())) {
        seen.add(m.mainTitle.toLowerCase());
        suggestions.push({ name: m.mainTitle.slice(0, 100), value: `mangadex:${m.id}` });
        count++;
      }
    }
  }

  if (muRaw.status === "fulfilled") {
    let count = 0;
    for (const m of muRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      if (m.title && !seen.has(m.title.toLowerCase())) {
        seen.add(m.title.toLowerCase());
        suggestions.push({ name: m.title.slice(0, 100), value: `mangaupdates:${m.id}` });
        count++;
      }
    }
  }

  if (jikanRaw.status === "fulfilled") {
    let count = 0;
    for (const m of jikanRaw.value) {
      if (count >= PER_SOURCE_LIMIT) break;
      if (m.mainTitle && !seen.has(m.mainTitle.toLowerCase())) {
        seen.add(m.mainTitle.toLowerCase());
        suggestions.push({ name: m.mainTitle.slice(0, 100), value: `jikan:${m.malId}` });
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
    const results = await withTimeout(searchAnime(query), TIMEOUT_MS);
    const suggestions: Suggestion[] = results
      .map((a) => {
        const title = a.title.english ?? a.title.romaji ?? a.title.native ?? "";
        return { name: title.slice(0, 100), value: `anilist-anime:${a.id}` };
      })
      .filter((s) => s.name.length > 0)
      .slice(0, 25);

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
