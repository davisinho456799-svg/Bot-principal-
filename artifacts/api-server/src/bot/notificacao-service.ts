import { type Client, EmbedBuilder, TextChannel } from "discord.js";
import {
  db,
  notificacaoCanaisTable,
  capitulosRastreados,
  favoritosTable,
  assinaturasTable,
  malHistoricoAlteracoesTable,
} from "@workspace/db";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getErogamescapeLastUpdated } from "./erogamescape.js";
import { buildScanLinksExternal } from "./commands/search.js";
import { getJikanMangaById, getJikanAnimeById, searchJikanAnimeAny } from "./jikan.js";
import { searchManhwaAny, searchAnime } from "./anilist.js";
import { searchComickAny } from "./comick.js";
import { searchMangaDexAny } from "./mangadex.js";
import { searchMangaUpdates } from "./mangaupdates.js";
import { searchJikanAny } from "./jikan.js";
import { recordBotError } from "./error-log.js";

const ANILIST_API = "https://graphql.anilist.co";
const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas

const CHAPTERS_QUERY = `
query GetChapters($id: Int!) {
  Media(id: $id, type: MANGA) {
    chapters
    updatedAt
    status
    title { english romaji }
    siteUrl
    coverImage { large color }
    externalLinks { site url }
  }
}
`;

interface MediaInfo {
  chapters: number | null;
  updatedAt: number | null;
  status: string | null;
  title: { english: string | null; romaji: string };
  siteUrl: string;
  coverImage: { large: string; color: string | null };
  externalLinks: { site: string; url: string }[] | null;
}

/** Extrai o UUID de uma URL do MangaDex, ex: https://mangadex.org/title/{uuid}/... */
function extractMangaDexUUID(url: string): string | null {
  const match = url.match(/mangadex\.org\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

/** Consulta o capítulo mais recente no MangaDex dado o UUID da obra */
async function fetchMangaDexLatestChapter(uuid: string): Promise<number | null> {
  try {
    const params = new URLSearchParams({ manga: uuid, limit: "1", "order[chapter]": "desc" });
    const res = await fetch(`https://api.mangadex.org/chapter?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: { attributes: { chapter: string | null } }[]; total: number };
    if (!json.data?.length) return null;
    const chap = json.data[0].attributes.chapter;
    return chap ? parseFloat(chap) : json.total;
  } catch {
    return null;
  }
}

/** Extrai o slug de uma URL do Comick, ex: https://comick.io/comic/{slug}/... */
function extractComickSlug(url: string): string | null {
  const match = url.match(/comick\.[^/]+\/comic\/([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Consulta o capítulo mais recente no Comick dado o slug da obra */
async function fetchComickLatestChapter(slug: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.comick.io/comic/${slug}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { comic?: { last_chapter?: number | null } };
    return json.comic?.last_chapter ?? null;
  } catch {
    return null;
  }
}

interface FetchResult {
  value: number;
  /** true = valor é timestamp/proxy, não um número de capítulos real */
  isProxy: boolean;
}

export type SourceAttempt = {
  source: string;
  status: "ok" | "sem_dados";
  value: number | null;
  selected: boolean;
};

export type NotificationCheckSummary = {
  titlesChecked: number;
  successfulSources: number;
  sourcesWithoutData: number;
  fallbackUsed: number;
  notificationsSent: number;
  attempts: Array<{
    title: string;
    primarySource: string;
    selectedSource: string | null;
    attempts: SourceAttempt[];
  }>;
};

interface MalSnapshot {
  chapters: number | null;
  synopsis: string | null;
  score: number | null;
  status: string | null;
}

// Mantém o snapshot inicial + até 10 registros posteriores de alteração.
const MAL_HISTORY_LIMIT = 10;

function normalizeSynopsis(value: string | null): string | null {
  return value?.replace(/\s+/g, " ").trim() || null;
}

function sameNullableNumber(a: number | null, b: number | null): boolean {
  return a === b || (a == null && b == null);
}

function sameNullableText(a: string | null, b: string | null): boolean {
  return a === b;
}

async function recordMalSnapshot(malId: string, title: string, snapshot: MalSnapshot) {
  const [previous] = await db
    .select()
    .from(malHistoricoAlteracoesTable)
    .where(eq(malHistoricoAlteracoesTable.malId, malId))
    .orderBy(desc(malHistoricoAlteracoesTable.observedAt), desc(malHistoricoAlteracoesTable.id))
    .limit(1);

  if (!previous) {
    await db.insert(malHistoricoAlteracoesTable).values({
      malId,
      title,
      synopsis: snapshot.synopsis,
      score: snapshot.score,
      status: snapshot.status,
      chapters: snapshot.chapters,
      changedFields: ["initial"],
    });
    return { previous: null, changedFields: [] as string[] };
  }

  const changedFields: string[] = [];
  if (normalizeSynopsis(previous.synopsis) !== normalizeSynopsis(snapshot.synopsis)) changedFields.push("synopsis");
  if (!sameNullableNumber(previous.score, snapshot.score)) changedFields.push("score");
  if (!sameNullableText(previous.status, snapshot.status)) changedFields.push("status");
  if (!sameNullableNumber(previous.chapters, snapshot.chapters)) changedFields.push("chapters");

  if (!changedFields.length) return { previous, changedFields };

  await db.insert(malHistoricoAlteracoesTable).values({
    malId,
    title,
    synopsis: snapshot.synopsis,
    score: snapshot.score,
    status: snapshot.status,
    chapters: snapshot.chapters,
    changedFields,
  });

  const historyRows = await db
    .select({
      id: malHistoricoAlteracoesTable.id,
      changedFields: malHistoricoAlteracoesTable.changedFields,
    })
    .from(malHistoricoAlteracoesTable)
    .where(eq(malHistoricoAlteracoesTable.malId, malId))
    .orderBy(desc(malHistoricoAlteracoesTable.observedAt), desc(malHistoricoAlteracoesTable.id));
  const oldRows = historyRows
    .filter((row) => !row.changedFields.includes("initial"))
    .slice(MAL_HISTORY_LIMIT);

  if (oldRows.length) {
    await db.delete(malHistoricoAlteracoesTable).where(
      inArray(malHistoricoAlteracoesTable.id, oldRows.map((row) => row.id)),
    );
  }

  return { previous, changedFields };
}

async function fetchChapters(manhwaId: string, source: string): Promise<FetchResult | null> {
  if (source === "anilist") {
    try {
      const res = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: CHAPTERS_QUERY, variables: { id: parseInt(manhwaId, 10) } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data: { Media: MediaInfo } };
      const media = json.data?.Media;
      if (!media) return null;
      if (media.chapters != null) return { value: media.chapters, isProxy: false };

      // Série em andamento: AniList não informa o capítulo atual.
      // Tenta cruzar com MangaDex e depois Comick via externalLinks da própria obra.
      const links = media.externalLinks ?? [];

      const mdLink = links.find((l) => l.url.toLowerCase().includes("mangadex.org"));
      if (mdLink) {
        const uuid = extractMangaDexUUID(mdLink.url);
        if (uuid) {
          const mdChapter = await fetchMangaDexLatestChapter(uuid);
          if (mdChapter != null) {
            logger.debug({ manhwaId, uuid }, "AniList em andamento: capítulo via MangaDex crossref");
            return { value: mdChapter, isProxy: false };
          }
        }
      }

      const comickLink = links.find((l) => l.url.toLowerCase().includes("comick."));
      if (comickLink) {
        const slug = extractComickSlug(comickLink.url);
        if (slug) {
          const comickChapter = await fetchComickLatestChapter(slug);
          if (comickChapter != null) {
            logger.debug({ manhwaId, slug }, "AniList em andamento: capítulo via Comick crossref");
            return { value: comickChapter, isProxy: false };
          }
        }
      }

      // Sem crossref disponível: usa updatedAt como proxy silencioso (não notifica)
      if (media.updatedAt != null) return { value: media.updatedAt, isProxy: true };
      return null;
    } catch {
      return null;
    }
  }

  if (source === "mangadex") {
    try {
      // Sem filtro de idioma: pega o capítulo mais recente em qualquer idioma
      const params = new URLSearchParams({ manga: manhwaId, limit: "1", "order[chapter]": "desc" });
      const res = await fetch(`https://api.mangadex.org/chapter?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { data: { attributes: { chapter: string | null } }[]; total: number };
      if (!json.data?.length) return null;
      const chap = json.data[0].attributes.chapter;
      const value = chap ? parseFloat(chap) : json.total;
      return { value, isProxy: false };
    } catch {
      return null;
    }
  }

  // Anime: usa o número do próximo episódio a ir ao ar - 1 como proxy do último episódio lançado
  if (source === "anilist-anime") {
    try {
      const ANIME_EP_QUERY = `
        query GetAnimeEp($id: Int!) {
          Media(id: $id, type: ANIME) {
            episodes
            nextAiringEpisode { episode }
            status
          }
        }
      `;
      const res = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ANIME_EP_QUERY, variables: { id: parseInt(manhwaId, 10) } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data: { Media: { episodes: number | null; nextAiringEpisode: { episode: number } | null; status: string | null } };
      };
      const media = json.data?.Media;
      if (!media) return null;
      if (media.nextAiringEpisode) return { value: media.nextAiringEpisode.episode - 1, isProxy: false };
      if (media.episodes != null) return { value: media.episodes, isProxy: false };
      return null;
    } catch {
      return null;
    }
  }

  if (source === "jikan-anime") {
    const anime = await getJikanAnimeById(Number(manhwaId));
    if (anime?.episodes == null) return null;
    return { value: anime.episodes, isProxy: false };
  }

  if (source === 'comick') {
    try {
      const res = await fetch(`https://api.comick.io/comic/${manhwaId}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { comic?: { last_chapter?: number | null }; last_chapter?: number | null };
      const lastChapter = json.comic?.last_chapter ?? (json as { last_chapter?: number | null }).last_chapter ?? null;
      if (lastChapter == null) return null;
      return { value: lastChapter, isProxy: false };
    } catch {
      return null;
    }
  }

  if (source === 'mangaupdates') {
    try {
      // MangaUpdates no longer exposes this as JSON at /releases. The old
      // endpoint now returns 405; the supported per-series feed is RSS/XML.
      const res = await fetch(`https://api.mangaupdates.com/v1/series/${manhwaId}/rss`, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const xml = await res.text();
      const chapter = parseMangaUpdatesRssChapter(xml);
      if (chapter === null) return null;
      return { value: chapter, isProxy: false };
    } catch {
      return null;
    }
  }

  if (source === 'jikan') {
    try {
      await new Promise((r) => setTimeout(r, 400));
      const res = await fetch(`https://api.jikan.moe/v4/manga/${manhwaId}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { chapters?: number | null } };
      const chapters = json.data?.chapters;
      if (chapters == null) return null;
      return { value: chapters, isProxy: false };
    } catch {
      return null;
    }
  }

  if (source === 'vndb') {
    try {
      const res = await fetch('https://api.vndb.org/kana/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: ['vn', '=', ['id', '=', manhwaId]],
          fields: 'id',
          results: 100,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { count?: number; results?: unknown[] };
      const count = json.count ?? json.results?.length ?? null;
      if (count == null) return null;
      return { value: count, isProxy: false };
    } catch {
      return null;
    }
  }

  if (source === "erogamescape") {
    // Rastreia via data de última atualização (最終更新日) — timestamp como proxy
    const ts = await getErogamescapeLastUpdated(manhwaId);
    if (ts === null) return null;
    return { value: Math.floor(ts / 1000), isProxy: true };
  }

  return null;
}

export interface TitleCheckResult {
  currentChapters: number | null;
  lastChapters: number | null;
  isProxy: boolean;
  hasNewChapters: boolean | null;
  durationMs: number;
}

/**
 * Consulta uma única fonte sem alterar a linha de base nem enviar notificações.
 * Usado pelo comando /verificar para diagnóstico manual.
 */
export async function checkTrackedTitle(
  manhwaId: string,
  source: string,
): Promise<TitleCheckResult> {
  const startedAt = Date.now();
  const [tracked] = await db
    .select({ lastChapters: capitulosRastreados.lastChapters })
    .from(capitulosRastreados)
    .where(eq(capitulosRastreados.manhwaId, manhwaId));
  const fetched = await fetchChapters(manhwaId, source);
  const currentChapters = fetched?.value ?? null;
  const isProxy = fetched?.isProxy ?? false;
  const hasNewChapters =
    currentChapters != null && !isProxy && tracked?.lastChapters != null
      ? currentChapters > tracked.lastChapters
      : null;

  return {
    currentChapters,
    lastChapters: tracked?.lastChapters ?? null,
    isProxy,
    hasNewChapters,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * MangaUpdates' RSS titles use values such as "Title c.200", "c.4-10",
 * and sometimes non-numeric labels like "c.Prologue". The feed is ordered
 * newest-first, but we calculate the maximum so duplicate scanlation-group
 * entries cannot make the tracked value move backwards.
 */
function parseMangaUpdatesRssChapter(xml: string): number | null {
  const titles = [...xml.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)]
    .map((match) => (match[1] ?? ""))
    .map((title) =>
      title
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&#039;/gi, "'")
        .trim(),
    );

  const chapters: number[] = [];
  for (const title of titles) {
    const match = title.match(
      /\b(?:chapter|ch|c)\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/i,
    );
    if (!match) continue;

    const endChapter = match[2] ?? match[1];
    const chapter = Number(endChapter);
    if (Number.isFinite(chapter)) chapters.push(chapter);
  }

  return chapters.length > 0 ? Math.max(...chapters) : null;
}

async function getTrackedManhwas() {
  const favorites = await db
    .selectDistinctOn([favoritosTable.manhwaId], {
      manhwaId: favoritosTable.manhwaId,
      source: favoritosTable.source,
      title: favoritosTable.title,
      coverUrl: favoritosTable.coverUrl,
      siteUrl: favoritosTable.siteUrl,
    })
    .from(favoritosTable);

  // Inclui também títulos assinados que não estejam nos favoritos
  const subscribed = await db
    .selectDistinctOn([assinaturasTable.manhwaId], {
      manhwaId: assinaturasTable.manhwaId,
      source: assinaturasTable.source,
      title: assinaturasTable.title,
      coverUrl: assinaturasTable.coverUrl,
      siteUrl: assinaturasTable.siteUrl,
    })
    .from(assinaturasTable);

  const seen = new Set(favorites.map((f) => f.manhwaId));
  for (const s of subscribed) {
    if (!seen.has(s.manhwaId)) {
      seen.add(s.manhwaId);
      favorites.push(s);
    }
  }

  return favorites;
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function likelySameTitle(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 8 && (a.includes(b) || b.includes(a)));
}

type FallbackCandidate = { source: string; id: string; title: string };

/**
 * Encontra IDs equivalentes nas outras bases somente quando a fonte principal
 * não respondeu. A confirmação pelo título evita trocar silenciosamente para
 * uma obra diferente com nome parecido.
 */
async function findFallbackCandidates(title: string, primarySource: string): Promise<FallbackCandidate[]> {
  const candidates: FallbackCandidate[] = [];
  const isAnime = primarySource === "anilist-anime" || primarySource === "jikan-anime";

  if (isAnime) {
    const searches = await Promise.allSettled([searchAnime(title), searchJikanAnimeAny(title)]);
    const [anilist, jikan] = searches;

    if (anilist.status === "fulfilled") {
      const match = anilist.value.find((item) =>
        [item.title.english, item.title.romaji, item.title.native, ...item.synonyms].some(
          (name) => name && likelySameTitle(name, title),
        ),
      );
      if (match && primarySource !== "anilist-anime") {
        candidates.push({ source: "anilist-anime", id: String(match.id), title });
      }
    }
    if (jikan.status === "fulfilled") {
      const match = jikan.value.find((item) =>
        [item.mainTitle, item.englishTitle, item.japaneseTitle, ...item.synonyms].some(
          (name) => name && likelySameTitle(name, title),
        ),
      );
      if (match && primarySource !== "jikan-anime") {
        candidates.push({ source: "jikan-anime", id: String(match.malId), title });
      }
    }
    return candidates;
  }

  const searches = await Promise.allSettled([
    searchManhwaAny(title),
    searchComickAny(title),
    searchMangaDexAny(title, 5),
    searchMangaUpdates(title),
    searchJikanAny(title),
  ]);

  const [anilist, comick, mangadex, mangaUpdates, jikan] = searches;
  if (anilist.status === "fulfilled") {
    const match = anilist.value.find((item) =>
      [item.title.english, item.title.romaji, item.title.native].some(
        (name) => name && likelySameTitle(name, title),
      ),
    );
    if (match && primarySource !== "anilist") {
      candidates.push({ source: "anilist", id: String(match.id), title });
    }
  }
  if (comick.status === "fulfilled") {
    const match = comick.value.find((item) => likelySameTitle(item.title, title));
    if (match && primarySource !== "comick") {
      candidates.push({ source: "comick", id: match.slug, title });
    }
  }
  if (mangadex.status === "fulfilled") {
    const match = mangadex.value.find((item) => likelySameTitle(item.mainTitle, title));
    if (match && primarySource !== "mangadex") {
      candidates.push({ source: "mangadex", id: match.id, title });
    }
  }
  if (mangaUpdates.status === "fulfilled") {
    const match = mangaUpdates.value.find((item) => likelySameTitle(item.title, title));
    if (match && primarySource !== "mangaupdates") {
      candidates.push({ source: "mangaupdates", id: match.id, title });
    }
  }
  if (jikan.status === "fulfilled") {
    const match = jikan.value.find((item) =>
      [item.mainTitle, item.englishTitle, item.japaneseTitle, ...item.synonyms].some(
        (name) => name && likelySameTitle(name, title),
      ),
    );
    if (match && primarySource !== "jikan") {
      candidates.push({ source: "jikan", id: String(match.malId), title });
    }
  }

  return candidates;
}

async function fetchWithFallback(
  title: string,
  primarySource: string,
  manhwaId: string,
  verifyAllSources = false,
): Promise<{ fetched: FetchResult | null; selectedSource: string | null; attempts: SourceAttempt[] }> {
  const attempts: SourceAttempt[] = [];
  const primary = await fetchChapters(manhwaId, primarySource);
  attempts.push({
    source: primarySource,
    status: primary && !primary.isProxy ? "ok" : "sem_dados",
    value: primary?.value ?? null,
    selected: false,
  });
  if (primary && !primary.isProxy && !verifyAllSources) {
    attempts[0]!.selected = true;
    return { fetched: primary, selectedSource: primarySource, attempts };
  }

  const candidates = await findFallbackCandidates(title, primarySource);
  const successful: Array<{ source: string; fetched: FetchResult }> = [];
  for (const candidate of candidates) {
    const fetched = await fetchChapters(candidate.id, candidate.source);
    attempts.push({
      source: candidate.source,
      status: fetched && !fetched.isProxy ? "ok" : "sem_dados",
      value: fetched?.value ?? null,
      selected: false,
    });
    if (fetched && !fetched.isProxy) {
      successful.push({ source: candidate.source, fetched });
      if (!verifyAllSources) break;
    }
  }

  const selected = primary
    ? (!primary.isProxy ? { source: primarySource, fetched: primary } : successful[0] ?? null)
    : successful[0] ?? null;
  if (selected) {
    const selectedAttempt = attempts.find((attempt) => attempt.source === selected.source);
    if (selectedAttempt) selectedAttempt.selected = true;
  }

  return {
    fetched: selected?.fetched ?? null,
    selectedSource: selected?.source ?? null,
    attempts,
  };
}

function addDiagnosisToSummary(
  summary: NotificationCheckSummary,
  title: string,
  primarySource: string,
  diagnosis: Awaited<ReturnType<typeof fetchWithFallback>>,
): void {
  summary.attempts.push({
    title,
    primarySource,
    selectedSource: diagnosis.selectedSource,
    attempts: diagnosis.attempts,
  });
  if (diagnosis.selectedSource) {
    summary.successfulSources++;
    if (diagnosis.selectedSource !== primarySource) summary.fallbackUsed++;
  } else {
    summary.sourcesWithoutData++;
  }

  for (const attempt of diagnosis.attempts) {
    if (attempt.status !== "sem_dados") continue;
    void recordBotError({
      source: "notification_source",
      errorCode: "SOURCE_NO_DATA",
      error: new Error(`A fonte ${attempt.source} não retornou capítulos`),
      context: {
        title,
        primarySource,
        attemptedSource: attempt.source,
      },
    });
  }
}

async function sendNotification(
  client: Client,
  channelId: string,
  title: string,
  newChapters: number,
  oldChapters: number | null,
  siteUrl: string,
  coverUrl: string | null,
  mentions: string[] = [],
  source?: string,
  isProxy = false,
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return false;

    const isAnime = source === "anilist-anime";
    const unidade = isAnime ? "episódio(s)" : "capítulo(s)";
    const PREFIX = `📬 Novo(s) ${isAnime ? "Episódio(s)" : "Capítulo(s)"}: `;

    const safeTitle = title.slice(0, 256 - PREFIX.length);

    // Quando isProxy (ex: updatedAt do AniList), não temos contagem real
    let descBody: string;
    if (isProxy) {
      descBody =
        `🆕 Novos conteúdos detectados!\n\n` +
        `🔎 **Buscar nos sites BR:**\n${buildScanLinksExternal(title)}`;
    } else {
      const newCount = Math.floor(newChapters);
      const oldCount = oldChapters != null ? Math.floor(oldChapters) : 0;
      const diff = newCount - oldCount;
      const unidadeLabel = isAnime ? "Episódio" : "Capítulo";
      const pad = (n: number) => String(n).padStart(3, "0");
      const progressao = oldCount > 0
        ? `**${pad(oldCount)} → ${pad(newCount)}**`
        : `**${pad(newCount)}**`;
      descBody =
        `📖 ${unidadeLabel} ${progressao}` +
        (diff > 1 ? ` *(+${diff} novos)*` : "") +
        `\n\n🔎 **Buscar nos sites BR:**\n${buildScanLinksExternal(title)}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${PREFIX}${safeTitle}`)
      .setURL(siteUrl || null)
      .setColor(0x2ecc71)
      .setDescription(descBody.slice(0, 4096))
      .setFooter({ text: "Notificação automática • Bot de Manhwa" });

    if (coverUrl) embed.setThumbnail(coverUrl);

    // Menciona os inscritos — respeita o limite de 2000 chars do Discord
    const content = mentions.length > 0 ? mentions.join(" ").slice(0, 2000) : undefined;

    await channel.send({ content, embeds: [embed] });
    return true;
  } catch (err) {
    logger.error({ err, channelId }, "Erro ao enviar notificação");
    void recordBotError({
      source: "notification",
      errorCode: "NOTIFICATION_SEND_FAILED",
      error: err,
      context: { channelId, title },
    });
    return false;
  }
}

async function sendMetadataNotification(
  client: Client,
  channelId: string,
  title: string,
  siteUrl: string,
  coverUrl: string | null,
  previous: {
    synopsis: string | null;
    score: number | null;
    status: string | null;
  },
  snapshot: {
    synopsis: string | null;
    score: number | null;
    status: string | null;
  },
  changedFields: string[],
): Promise<boolean> {
  const metadataFields = changedFields.filter((field) => field !== "chapters");
  if (!metadataFields.length) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return false;

    const labels: Record<string, string> = {
      synopsis: "Sinopse",
      score: "Nota",
      status: "Status",
    };
    const fields = metadataFields.map((field) => {
      if (field === "synopsis") {
        return {
          name: "📝 Sinopse atualizada",
          value: `A sinopse da página foi alterada.\n\n**Nova sinopse:**\n${(snapshot.synopsis ?? "Não informada").slice(0, 900)}`,
          inline: false,
        };
      }
      const oldValue =
        field === "score" ? previous.score ?? "—" : previous.status ?? "—";
      const newValue =
        field === "score" ? snapshot.score ?? "—" : snapshot.status ?? "—";
      return {
        name: `${field === "score" ? "⭐" : "📌"} ${labels[field] ?? field} atualizado`,
        value: `**${String(oldValue)}** → **${String(newValue)}**`,
        inline: true,
      };
    });

    const embed = new EmbedBuilder()
      .setTitle(`📝 Alteração na página: ${title}`.slice(0, 256))
      .setURL(siteUrl || null)
      .setColor(0x3498db)
      .setDescription("A página deste título no MyAnimeList foi atualizada.")
      .addFields(fields)
      .setFooter({ text: "Alteração de página • MyAnimeList" });

    if (coverUrl) embed.setThumbnail(coverUrl);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    logger.error({ err, channelId }, "Erro ao enviar notificação de alteração");
    void recordBotError({
      source: "notification",
      errorCode: "METADATA_NOTIFICATION_SEND_FAILED",
      error: err,
      context: { channelId, title, changedFields: metadataFields },
    });
    return false;
  }
}

export async function runCheck(
  client: Client,
  options: { verifyAllSources?: boolean } = {},
): Promise<NotificationCheckSummary> {
  logger.info("Verificando atualizações de capítulos...");

  const canais = await db.select().from(notificacaoCanaisTable);
  const manhwas = await getTrackedManhwas();
  const summary: NotificationCheckSummary = {
    titlesChecked: manhwas.length,
    successfulSources: 0,
    sourcesWithoutData: 0,
    fallbackUsed: 0,
    notificationsSent: 0,
    attempts: [],
  };
  if (!manhwas.length) return summary;

  for (const m of manhwas) {
    try {
      let prefetchedDiagnosis: Awaited<ReturnType<typeof fetchWithFallback>> | null = null;

      if (m.source === "jikan") {
        const mal = await getJikanMangaById(Number(m.manhwaId));
        if (!mal || mal.chapters == null) {
          logger.debug({ title: m.title, manhwaId: m.manhwaId }, "MAL/Jikan retornou null — pulando título");
          prefetchedDiagnosis = await fetchWithFallback(
            m.title,
            m.source,
            m.manhwaId,
            options.verifyAllSources ?? false,
          );
        } else if (options.verifyAllSources) {
          // O teste administrativo consulta as alternativas mesmo quando o
          // MAL respondeu, para mostrar a saúde de todas as fontes.
          prefetchedDiagnosis = await fetchWithFallback(m.title, m.source, m.manhwaId, true);
          addDiagnosisToSummary(summary, m.title, m.source, prefetchedDiagnosis);
        } else {
          addDiagnosisToSummary(summary, m.title, m.source, {
            fetched: { value: mal.chapters ?? 0, isProxy: false },
            selectedSource: m.source,
            attempts: [{
              source: m.source,
              status: mal.chapters != null ? "ok" : "sem_dados",
              value: mal.chapters,
              selected: mal.chapters != null,
            }],
          });
        }

        if (mal && mal.chapters != null) {
          const snapshot: MalSnapshot = {
          chapters: mal.chapters,
          synopsis: mal.synopsis,
          score: mal.score,
          status: mal.rawStatus ?? mal.status,
          };
          const [tracked] = await db
          .select({
            id: capitulosRastreados.id,
            lastChapters: capitulosRastreados.lastChapters,
          })
          .from(capitulosRastreados)
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
          const { previous, changedFields } = await recordMalSnapshot(m.manhwaId, m.title, snapshot);

          if (!tracked) {
            await db.insert(capitulosRastreados).values({
              manhwaId: m.manhwaId,
              source: m.source,
              title: m.title,
              coverUrl: m.coverUrl,
              siteUrl: m.siteUrl,
              lastChapters: snapshot.chapters,
            });
          } else {
            const update: {
              lastChecked: ReturnType<typeof sql>;
              lastChapters?: number;
            } = { lastChecked: sql`now()` };
            if (snapshot.chapters != null && Number.isFinite(snapshot.chapters)) {
              update.lastChapters = snapshot.chapters;
            }
            await db
              .update(capitulosRastreados)
              .set(update)
              .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
          }

          // Após a implantação do histórico, use o rastreador existente como
          // baseline até que a primeira linha histórica esteja disponível.
          const previousChapters = previous?.chapters ?? tracked?.lastChapters ?? null;
          const chapterIncreased =
            previousChapters != null &&
            snapshot.chapters != null &&
            snapshot.chapters > previousChapters;

          if (chapterIncreased && snapshot.chapters != null && previousChapters != null) {
            logger.info(
              { title: m.title, previousChapters, newChapters: snapshot.chapters, changedFields },
              "Novo capítulo do MAL detectado",
            );
            for (const canal of canais) {
              const subscribers = await db
                .select({ discordUserId: assinaturasTable.discordUserId })
                .from(assinaturasTable)
                .where(
                  and(
                    eq(assinaturasTable.manhwaId, m.manhwaId),
                    eq(assinaturasTable.guildId, canal.guildId),
                  ),
                );
              const mentions = subscribers.map((s) => `<@${s.discordUserId}>`);
              const sent = await sendNotification(
                client,
                canal.channelId,
                m.title,
                snapshot.chapters,
                previousChapters,
                m.siteUrl,
                m.coverUrl ?? null,
                mentions,
                m.source,
              );
              if (sent) summary.notificationsSent++;
            }
          }

          const metadataChanged = changedFields.filter((field) => field !== "chapters");
          if (metadataChanged.length) {
            logger.info(
              { title: m.title, changedFields },
              "Alteração de metadados do MAL registrada",
            );
            for (const canal of canais) {
              if (!canal.alterationChannelId) continue;
              const sent = await sendMetadataNotification(
                client,
                canal.alterationChannelId,
                m.title,
                m.siteUrl,
                m.coverUrl ?? null,
                previous ?? {
                  synopsis: null,
                  score: null,
                  status: null,
                },
                snapshot,
                metadataChanged,
              );
              if (sent) summary.notificationsSent++;
            }
          }

          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }

      const diagnosis = prefetchedDiagnosis ?? await fetchWithFallback(
        m.title,
        m.source,
        m.manhwaId,
        options.verifyAllSources ?? false,
      );
      if (!prefetchedDiagnosis || m.source !== "jikan" || !options.verifyAllSources) {
        addDiagnosisToSummary(summary, m.title, m.source, diagnosis);
      }

      const fetched = diagnosis.fetched;
      if (fetched === null) {
        logger.debug({ title: m.title, source: m.source, manhwaId: m.manhwaId }, "API retornou null — pulando título");
        continue;
      }

      const { value: newChapters, isProxy } = fetched;

      const [existing] = await db
        .select()
        .from(capitulosRastreados)
        .where(eq(capitulosRastreados.manhwaId, m.manhwaId));

      if (!existing) {
        await db.insert(capitulosRastreados).values({
          manhwaId: m.manhwaId,
          source: m.source,
          title: m.title,
          coverUrl: m.coverUrl,
          siteUrl: m.siteUrl,
          lastChapters: newChapters,
        });
        continue;
      }

      const lastChapters = existing.lastChapters ?? 0;

      if (newChapters > lastChapters) {
        logger.info({ title: m.title, lastChapters, newChapters, isProxy }, "Novos conteúdos detectados!");

        // isProxy = true significa que estamos rastreando por timestamp (ex: updatedAt do AniList).
        // Não enviamos notificação nesses casos — só atualizamos o DB — para evitar falsos positivos
        // causados por edições de metadados (capa, sinopse, etc.) que também alteram updatedAt.
        if (!isProxy) {
            for (const canal of canais) {
            const subscribers = await db
              .select({ discordUserId: assinaturasTable.discordUserId })
              .from(assinaturasTable)
              .where(
                and(
                  eq(assinaturasTable.manhwaId, m.manhwaId),
                  eq(assinaturasTable.guildId, canal.guildId)
                )
              );
            const mentions = subscribers.map((s) => `<@${s.discordUserId}>`);
              const sent = await sendNotification(client, canal.channelId, m.title, newChapters, lastChapters, m.siteUrl, m.coverUrl ?? null, mentions, diagnosis.selectedSource ?? m.source, isProxy);
              if (sent) summary.notificationsSent++;
          }
        }

        await db
          .update(capitulosRastreados)
          .set({ lastChapters: newChapters, lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
      } else {
        await db
          .update(capitulosRastreados)
          .set({ lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.error({ err, manhwa: m.title }, "Erro ao verificar capítulos");
      void recordBotError({
        source: "notification",
        errorCode: "TITLE_CHECK_FAILED",
        error: err,
        context: {
          manhwaId: m.manhwaId,
          title: m.title,
          source: m.source,
        },
      });
    }
  }

  logger.info("Verificação de capítulos concluída.");
  return summary;
}

export function startNotificacaoService(client: Client) {
  const runSafe = async () => {
    try {
      await runCheck(client);
    } catch (err) {
      logger.error({ err }, "Erro no serviço de notificações");
      void recordBotError({
        source: "notification",
        errorCode: "NOTIFICATION_SERVICE_FAILED",
        error: err,
      });
    }
  };

  setTimeout(runSafe, 60_000);
  setInterval(runSafe, CHECK_INTERVAL_MS);
  logger.info({ intervalHoras: 2 }, "Serviço de notificações iniciado");
}
