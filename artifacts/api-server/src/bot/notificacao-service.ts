import { type Client, EmbedBuilder } from "discord.js";
import {
  db,
  notificacaoCanaisTable,
  capitulosRastreados,
  favoritosTable,
  assinaturasTable,
  malHistoricoAlteracoesTable,
} from "@workspace/db";
import { eq, sql, and, desc, inArray, gte, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getErogamescapeLastUpdated } from "./erogamescape.js";
import { buildScanLinksExternal } from "./commands/search.js";
import { getJikanMangaById, getJikanAnimeById, searchJikanAnimeAny } from "./jikan.js";
import { searchManhwaAny, searchAnime } from "./anilist.js";
import { searchComickAny, getComickBySlug } from "./comick.js";
import { searchMangaDexAny } from "./mangadex.js";
import { searchMangaUpdates } from "./mangaupdates.js";
import { searchJikanAny } from "./jikan.js";
import { recordBotError } from "./error-log.js";
import {
  type FetchResult,
  type FetchError,
  type SourceErrorKind,
  fetchError,
  isFetchError,
  normalizeChapterValue,
  classifyHttpStatus,
  classifyException,
  normalizeSynopsis,
  sameNullableNumber,
  sameNullableText,
} from "./notificacao-utils.js";
import { fetchComick, parseComickJson } from "./comick-http.js";
export type { SourceErrorKind } from "./notificacao-utils.js";

const ANILIST_API = "https://graphql.anilist.co";
const COMICK_API_BASE = (process.env.COMICK_API_BASE ?? "https://api.comick.dev").replace(/\/+$/, "");
const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas
// A pausa deve proteger a fonte que impõe limite, não parar a fila inteira por
// um minuto. O scanner continua sequencial; esta margem evita rajadas no
// Comick sem deixar dezenas de títulos esperando desnecessariamente.
const BETWEEN_TITLES_DELAY_MS = 10_000;
const COMICK_COOLDOWN_STEPS_MS = [
  30 * 60 * 1000, // primeiro bloqueio: 30 min
  2 * 60 * 60 * 1000, // segundo bloqueio: 2 h
  6 * 60 * 60 * 1000, // bloqueios seguintes: 6 h
] as const;
let comickBlockedUntil = 0;
let comickBlockCount = 0;
let verificationInProgress = false;

function isComickBlocked(): boolean {
  return Date.now() < comickBlockedUntil;
}

function blockComick(title: string, status: number): void {
  const cooldownMs =
    COMICK_COOLDOWN_STEPS_MS[
      Math.min(comickBlockCount, COMICK_COOLDOWN_STEPS_MS.length - 1)
    ];
  comickBlockCount++;
  comickBlockedUntil = Date.now() + cooldownMs;
  logger.warn(
    {
      title,
      status,
      blockCount: comickBlockCount,
      cooldownMinutes: cooldownMs / 60_000,
    },
    "Comick ativou proteção — pausando consultas ao Comick",
  );
}

/**
 * Discord pode devolver canais de anúncio, threads ou canais vindos de uma
 * versão diferente do discord.js. `instanceof TextChannel` rejeita esses
 * canais mesmo quando eles aceitam mensagens, fazendo o serviço retornar
 * `false` sem tentar enviar nada.
 */
type SendableDiscordChannel = {
  send(payload: unknown): Promise<unknown>;
};

function getSendableChannel(
  channel: unknown,
  channelId: string,
): SendableDiscordChannel | null {
  if (
    channel &&
    typeof channel === "object" &&
    typeof (channel as { send?: unknown }).send === "function"
  ) {
    return channel as SendableDiscordChannel;
  }

  const details =
    channel && typeof channel === "object"
      ? {
          channelType:
            "type" in channel ? String((channel as { type?: unknown }).type) : "unknown",
          className:
            "constructor" in channel
              ? String(
                  (channel as { constructor?: { name?: unknown } }).constructor?.name ??
                    "unknown",
                )
              : "unknown",
        }
      : { channelType: "null", className: "null" };
  logger.warn({ channelId, ...details }, "Canal de notificação não é enviável");
  return null;
}

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
    // Capítulos especiais ("EX", "Oneshot", "SP") produzem NaN com parseFloat;
    // normalizeChapterValue retorna null nesses casos.
    return normalizeChapterValue(chap ?? json.total);
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
    const res = await fetchComick(
      `${COMICK_API_BASE}/comic/${encodeURIComponent(slug)}`,
    );
    // 404 pode indicar slug renomeado; tenta recuperar via busca antes de desistir
    if (res.status === 404) {
      const recovered = await getComickBySlug(slug);
      return recovered?.last_chapter ?? null;
    }
    if (!res.ok) return null;
    const json = parseComickJson<{
      comic?: { last_chapter?: number | null };
    }>(res);
    return json.comic?.last_chapter ?? null;
  } catch {
    return null;
  }
}


let mangaUpdatesSessionToken: string | null = null;
let mangaUpdatesSessionExpiresAt = 0;

// ─── Classificação e registo de erros de fonte ───────────────────────────────

function recordSourceError(
  source: string,
  manhwaId: string,
  kind: SourceErrorKind,
  httpStatus?: number,
): void {
  void recordBotError({
    source: "notification_source",
    errorCode: `SOURCE_${kind.toUpperCase().replace(/-/g, "_")}`,
    error: new Error(httpStatus ? `${source} HTTP ${httpStatus}` : `${source} ${kind}`),
    context: { source, manhwaId, errorKind: kind, ...(httpStatus ? { httpStatus } : {}) },
  });
}

async function getMangaUpdatesSessionToken(forceRefresh = false): Promise<string | null> {
  if (
    !forceRefresh &&
    mangaUpdatesSessionToken &&
    mangaUpdatesSessionExpiresAt > Date.now()
  ) {
    return mangaUpdatesSessionToken;
  }

      const username = process.env.MANGAUPDATES_USERNAME;
      const password = process.env.MANGAUPDATES_PASSWORD;
      if (!username || !password) return null;

  try {
    const res = await fetch("https://api.mangaupdates.com/v1/account/login", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      context?: { session_token?: string };
    };
    const token = json.context?.session_token;
    if (!token) return null;

    // A sessão é reutilizada durante uma hora; em caso de 401 ela é renovada.
    mangaUpdatesSessionToken = token;
    mangaUpdatesSessionExpiresAt = Date.now() + 60 * 60 * 1000;
    return token;
  } catch {
    return null;
  }
}

function parseMangaUpdatesStatusChapter(status: string | null | undefined): number | null {
  if (!status) return null;
  const chapters = [...status.matchAll(/(\d+(?:\.\d+)?)\s+Chapters?/gi)]
    .map((match) => Number(match[1]))
    .filter((chapter) => Number.isFinite(chapter));
  return chapters.length ? Math.max(...chapters) : null;
}

export type SourceAttempt = {
  source: string;
  status: "ok" | "sem_dados";
  value: number | null;
  selected: boolean;
  /** Tipo de falha; presente quando status é "sem_dados". */
  errorKind?: SourceErrorKind;
  /** HTTP status code quando a falha é HTTP. */
  httpStatus?: number;
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

async function fetchChapters(
  manhwaId: string,
  source: string,
): Promise<FetchResult | FetchError | null> {
  if (source === "anilist") {
    try {
      const res = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: CHAPTERS_QUERY, variables: { id: parseInt(manhwaId, 10) } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = (await res.json()) as { data: { Media: MediaInfo } };
      const media = json.data?.Media;
      if (!media) return fetchError("invalid_response");
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

      // updatedAt é apenas um timestamp da página, não uma contagem de capítulos.
      // Não o use como baseline: alterações de capa/sinopse também mudam esse valor.
      return fetchError("no_data");
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "mangadex") {
    try {
      // Sem filtro de idioma: pega o capítulo mais recente em qualquer idioma
      const params = new URLSearchParams({ manga: manhwaId, limit: "1", "order[chapter]": "desc" });
      const res = await fetch(`https://api.mangadex.org/chapter?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = (await res.json()) as { data: { attributes: { chapter: string | null } }[]; total: number };
      if (!json.data?.length) return fetchError("no_data");
      const chap = json.data[0].attributes.chapter;
      // Capítulos especiais ("EX", "Oneshot", "SP") não são numéricos;
      // normalizeChapterValue rejeita-os e devolve null → no_data.
      const value = normalizeChapterValue(chap ?? json.total);
      if (value === null) return fetchError("no_data");
      return { value, isProxy: false };
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
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
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = (await res.json()) as {
        data: { Media: { episodes: number | null; nextAiringEpisode: { episode: number } | null; status: string | null } };
      };
      const media = json.data?.Media;
      if (!media) return fetchError("invalid_response");
      if (media.nextAiringEpisode) return { value: media.nextAiringEpisode.episode - 1, isProxy: false };
      if (media.episodes != null) return { value: media.episodes, isProxy: false };
      return fetchError("no_data");
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "jikan-anime") {
    const anime = await getJikanAnimeById(Number(manhwaId));
    if (anime?.episodes == null) return fetchError("no_data");
    return { value: anime.episodes, isProxy: false };
  }

  if (source === "comick") {
    try {
      if (isComickBlocked()) {
        logger.debug({ manhwaId }, "Consulta ao Comick ignorada durante cooldown");
        return fetchError("http_429", 429);
      }
      const res = await fetchComick(
        `${COMICK_API_BASE}/comic/${encodeURIComponent(manhwaId)}`,
      );
      if (!res.ok) {
        // 404 pode indicar que o slug foi renomeado; tenta recuperar via busca
        // antes de tratar como obra indisponível.
        if (res.status === 404) {
          const recovered = await getComickBySlug(manhwaId);
          if (recovered) {
            const lastChapter = recovered.last_chapter ?? null;
            if (lastChapter == null) return fetchError("no_data");
            const newManhwaId =
              recovered.slug && recovered.slug !== manhwaId
                ? recovered.slug
                : undefined;
            return { value: lastChapter, isProxy: false, newManhwaId };
          }

          // Algumas obras aparecem na busca com `last_chapter`, mas o
          // endpoint de detalhe responde 404. Nesse caso a busca já contém
          // informação suficiente para o rastreamento.
          const searchResults = await searchComickAny(
            manhwaId.replace(/[-_]+/g, " "),
          ).catch(() => []);
          const match = searchResults.find((item) =>
            [item.title, ...(item.md_titles ?? []).map((entry) => entry.title)]
              .some((name) => name && likelySameTitle(name, manhwaId)),
          );
          if (match?.last_chapter != null) {
            return {
              value: match.last_chapter,
              isProxy: false,
              newManhwaId: match.slug && match.slug !== manhwaId ? match.slug : undefined,
            };
          }

          recordSourceError(source, manhwaId, "http_404", 404);
          return fetchError("http_404", 404);
        }
        if (res.status === 403 || res.status === 429) {
          blockComick(manhwaId, res.status);
          const kind = classifyHttpStatus(res.status);
          recordSourceError(source, manhwaId, kind, res.status);
          return fetchError(kind, res.status);
        }
        // Para outros erros HTTP (como 5xx), tenta o endpoint de busca como
        // fallback interno do Comick antes de desistir. 403/429 entram em
        // cooldown acima para não insistir enquanto a proteção está ativa.
        logger.debug({ manhwaId, httpStatus: res.status }, "Comick /comic/{slug} bloqueado — tentando /v1.0/search");
        try {
          const searchRes = await fetchComick(
            `${COMICK_API_BASE}/v1.0/search?${new URLSearchParams({ q: manhwaId, limit: "10" })}`,
          );
          if (searchRes.ok) {
            const items = parseComickJson<
              Array<{ slug?: string; last_chapter?: number | null }>
            >(searchRes);
            const match = items.find((item) => item.slug === manhwaId);
            if (match && match.last_chapter != null) {
              logger.debug({ manhwaId, last_chapter: match.last_chapter }, "Comick search fallback bem-sucedido");
              return { value: match.last_chapter, isProxy: false };
            }
          }
        } catch {
          // Search também falhou — segue para o erro original
        }
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = parseComickJson<{
        comic?: { last_chapter?: number | null };
        last_chapter?: number | null;
      }>(res);
      const lastChapter = json.comic?.last_chapter ?? (json as { last_chapter?: number | null }).last_chapter ?? null;
      if (lastChapter == null) return fetchError("no_data");
      // Uma resposta bem-sucedida encerra a sequência de bloqueios.
      comickBlockCount = 0;
      return { value: lastChapter, isProxy: false };
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "mangaupdates") {
    try {
      const token = await getMangaUpdatesSessionToken();

      // O endpoint de detalhes funciona publicamente para muitas obras. As
      // credenciais melhoram a consistência, mas a ausência delas não deve
      // transformar a fonte inteira em "sem dados".
      const requestSeries = async (sessionToken: string | null) =>
        fetch(`https://api.mangaupdates.com/v1/series/${encodeURIComponent(manhwaId)}`, {
          headers: {
            Accept: "application/json",
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          },
          signal: AbortSignal.timeout(8000),
        });

      let res = await requestSeries(token);
      if (res.status === 401) {
        const refreshedToken = await getMangaUpdatesSessionToken(true);
        if (!refreshedToken) {
          const kind = classifyHttpStatus(res.status);
          recordSourceError(source, manhwaId, kind, res.status);
          return fetchError(kind, res.status);
        }
        res = await requestSeries(refreshedToken);
      }
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }

      const series = (await res.json()) as {
        latest_chapter?: number | string | null;
        status?: string | null;
      };
      const latestChapter = normalizeChapterValue(series.latest_chapter);
      const statusChapter = parseMangaUpdatesStatusChapter(series.status);
      const chapter = Math.max(latestChapter ?? 0, statusChapter ?? 0);

      if (chapter <= 0) return fetchError("no_data");
      return { value: chapter, isProxy: false };
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "jikan") {
    try {
      await new Promise((r) => setTimeout(r, 400));
      const res = await fetch(`https://api.jikan.moe/v4/manga/${manhwaId}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = (await res.json()) as { data?: { chapters?: number | null } };
      const chapters = json.data?.chapters;
      if (chapters == null) return fetchError("no_data");
      return { value: chapters, isProxy: false };
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "vndb") {
    try {
      const res = await fetch("https://api.vndb.org/kana/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: ["vn", "=", ["id", "=", manhwaId]],
          fields: "id",
          results: 100,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        recordSourceError(source, manhwaId, kind, res.status);
        return fetchError(kind, res.status);
      }
      const json = (await res.json()) as { count?: number; results?: unknown[] };
      const count = json.count ?? json.results?.length ?? null;
      if (count == null) return fetchError("no_data");
      return { value: count, isProxy: false };
    } catch (err) {
      const kind = classifyException(err);
      recordSourceError(source, manhwaId, kind);
      return fetchError(kind);
    }
  }

  if (source === "erogamescape") {
    // Rastreia via data de última atualização (最終更新日) — timestamp como proxy
    const ts = await getErogamescapeLastUpdated(manhwaId);
    if (ts === null) return fetchError("no_data");
    return { value: Math.floor(ts / 1000), isProxy: true };
  }

  return null; // fonte desconhecida
}

export interface TitleCheckResult {
  currentChapters: number | null;
  lastChapters: number | null;
  isProxy: boolean;
  hasNewChapters: boolean | null;
  selectedSource: string | null;
  durationMs: number;
}

/**
 * Consulta uma única fonte sem alterar a linha de base nem enviar notificações.
 * Usado pelo comando /verificar para diagnóstico manual.
 */
export interface TitleResetResult {
  currentChapters: number | null;
  previousLastChapters: number | null;
  resetDone: boolean;
  selectedSource: string | null;
  durationMs: number;
}

/**
 * Consulta a fonte e atualiza a linha de base para o valor atual.
 * Permite corrigir manualmente um baseline corrompido ou desatualizado.
 */
export async function resetTrackedTitle(
  manhwaId: string,
  source: string,
  title?: string,
): Promise<TitleResetResult> {
  const startedAt = Date.now();
  const check = await checkTrackedTitle(manhwaId, source, title);

  if (check.currentChapters == null || check.isProxy) {
    return {
      currentChapters: check.currentChapters,
      previousLastChapters: check.lastChapters,
      resetDone: false,
      selectedSource: check.selectedSource,
      durationMs: Date.now() - startedAt,
    };
  }

  await db
    .update(capitulosRastreados)
    .set({ lastChapters: check.currentChapters, lastChecked: sql`now()` })
    .where(eq(capitulosRastreados.manhwaId, manhwaId));

  return {
    currentChapters: check.currentChapters,
    previousLastChapters: check.lastChapters,
    resetDone: true,
    selectedSource: check.selectedSource,
    durationMs: Date.now() - startedAt,
  };
}

export async function checkTrackedTitle(
  manhwaId: string,
  source: string,
  title?: string,
): Promise<TitleCheckResult> {
  const startedAt = Date.now();
  const [tracked] = await db
    .select({ lastChapters: capitulosRastreados.lastChapters })
    .from(capitulosRastreados)
    .where(eq(capitulosRastreados.manhwaId, manhwaId));
  let fetched: FetchResult | null;
  let selectedSource: string | null;

  // Registros antigos do AniList devem ser verificados pelo Comick primeiro.
  // Mantemos o ID original apenas para comparar com a linha de base salva.
  if (source === "anilist" && title) {
    const diagnosis = await fetchWithFallback(title, source, manhwaId, false, false);
    fetched = diagnosis.fetched;
    selectedSource = diagnosis.selectedSource;
  } else {
    const raw = await fetchChapters(manhwaId, source);
    fetched = isFetchError(raw) ? null : raw;
    selectedSource = fetched ? source : null;
  }

  // O MAL/Jikan frequentemente deixa `chapters` nulo em obras em andamento.
  // Nesse caso, tenta uma fonte equivalente pelo título, sem alterar a linha
  // de base nem disparar notificações.
  if ((!fetched || fetched.isProxy) && title && source !== "anilist") {
    const diagnosis = await fetchWithFallback(title, source, manhwaId);
    fetched = diagnosis.fetched;
    selectedSource = diagnosis.selectedSource;
  }

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
    selectedSource,
    durationMs: Date.now() - startedAt,
  };
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

const MANGA_NOTIFICATION_SOURCES = new Set([
  "anilist",
  "comick",
  "mangadex",
  "mangaupdates",
  "jikan",
]);

const MANGA_NOTIFICATION_SOURCE_ORDER = [
  "comick",
  "mangadex",
  "mangaupdates",
  "jikan",
  "anilist",
];

function isMangaNotificationSource(source: string): boolean {
  return MANGA_NOTIFICATION_SOURCES.has(source);
}

/**
 * Encontra IDs equivalentes nas outras bases somente quando a fonte principal
 * não respondeu. A confirmação pelo título evita trocar silenciosamente para
 * uma obra diferente com nome parecido.
 */
async function findFallbackCandidates(
  title: string,
  primarySource: string,
  includePrimary = false,
): Promise<FallbackCandidate[]> {
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

  const shouldSearchAniList = includePrimary || primarySource !== "anilist";
  const searches = await Promise.allSettled([
    shouldSearchAniList ? searchManhwaAny(title) : Promise.resolve([]),
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
    if (match && (includePrimary || primarySource !== "anilist")) {
      candidates.push({ source: "anilist", id: String(match.id), title });
    }
  }
  if (comick.status === "fulfilled") {
    const match = comick.value.find(
      (item) =>
        typeof item.title === "string" &&
        typeof item.slug === "string" &&
        likelySameTitle(item.title, title),
    );
    if (match?.slug && (includePrimary || primarySource !== "comick")) {
      candidates.push({ source: "comick", id: match.slug, title });
    }
  }
  if (mangadex.status === "fulfilled") {
    const match = mangadex.value.find((item) => likelySameTitle(item.mainTitle, title));
    if (match && (includePrimary || primarySource !== "mangadex")) {
      candidates.push({ source: "mangadex", id: match.id, title });
    }
  }
  if (mangaUpdates.status === "fulfilled") {
    const match = mangaUpdates.value.find((item) => likelySameTitle(item.title, title));
    if (match && (includePrimary || primarySource !== "mangaupdates")) {
      candidates.push({ source: "mangaupdates", id: match.id, title });
    }
  }
  if (jikan.status === "fulfilled") {
    const match = jikan.value.find((item) =>
      [item.mainTitle, item.englishTitle, item.japaneseTitle, ...item.synonyms].some(
        (name) => name && likelySameTitle(name, title),
      ),
    );
    if (match && (includePrimary || primarySource !== "jikan")) {
      candidates.push({ source: "jikan", id: String(match.malId), title });
    }
  }

  return candidates.sort(
    (left, right) =>
      MANGA_NOTIFICATION_SOURCE_ORDER.indexOf(left.source) -
      MANGA_NOTIFICATION_SOURCE_ORDER.indexOf(right.source),
  );
}

async function fetchWithFallback(
  title: string,
  primarySource: string,
  manhwaId: string,
  verifyAllSources = false,
  includePrimarySource = true,
): Promise<{ fetched: FetchResult | null; selectedSource: string | null; attempts: SourceAttempt[] }> {
  const attempts: SourceAttempt[] = [];

  // ── Anime / VN: comportamento sequencial preservado ──────────────────────
  if (!isMangaNotificationSource(primarySource)) {
    const rawPrimary = await fetchChapters(manhwaId, primarySource);
    const primary = isFetchError(rawPrimary) ? null : rawPrimary;
    attempts.push({
      source: primarySource,
      status: primary && !primary.isProxy ? "ok" : "sem_dados",
      value: primary?.value ?? null,
      selected: false,
      errorKind: isFetchError(rawPrimary) ? rawPrimary.kind : (primary == null ? "no_data" : undefined),
      httpStatus: isFetchError(rawPrimary) ? rawPrimary.httpStatus : undefined,
    });
    if (primary && !primary.isProxy && !verifyAllSources) {
      attempts[0]!.selected = true;
      return { fetched: primary, selectedSource: primarySource, attempts };
    }

    const candidates = await findFallbackCandidates(title, primarySource);
    const successful: Array<{ source: string; fetched: FetchResult }> = [];
    for (const candidate of candidates) {
      const rawFetched = await fetchChapters(candidate.id, candidate.source);
      const fetched = isFetchError(rawFetched) ? null : rawFetched;
      attempts.push({
        source: candidate.source,
        status: fetched && !fetched.isProxy ? "ok" : "sem_dados",
        value: fetched?.value ?? null,
        selected: false,
        errorKind: isFetchError(rawFetched) ? rawFetched.kind : (fetched == null ? "no_data" : undefined),
        httpStatus: isFetchError(rawFetched) ? rawFetched.httpStatus : undefined,
      });
      if (fetched && !fetched.isProxy) {
        successful.push({ source: candidate.source, fetched });
        if (!verifyAllSources) break;
      }
    }

    const selectedAnime = primary
      ? (!primary.isProxy ? { source: primarySource, fetched: primary } : successful[0] ?? null)
      : successful[0] ?? null;
    if (selectedAnime) {
      const a = attempts.find((x) => x.source === selectedAnime.source);
      if (a) a.selected = true;
    }
    return {
      fetched: selectedAnime?.fetched ?? null,
      selectedSource: selectedAnime?.source ?? null,
      attempts,
    };
  }

  // ── Manga / manhwa: fontes auxiliares em paralelo ─────────────────────────
  //
  // O Comick fica fora deste grupo: busca e consulta precisam ser sequenciais,
  // porque o Cloudflare pode bloquear uma rajada de requisições.

  const PARALLEL_SOURCES = ["mangadex", "mangaupdates"] as const;

  const parallelTasks = PARALLEL_SOURCES.map(async (source) => {
    logger.debug({ title, source }, "Consultando fonte alternativa");
    // Determina o ID a consultar
    let id: string | null = null;

    if (source === primarySource) {
      // Usa o ID existente, respeitando includePrimarySource
      id = includePrimarySource ? manhwaId : null;
    } else {
      // Pesquisa pelo título para fontes não-primárias
      if (source === "mangadex") {
        const results = await searchMangaDexAny(title, 5).catch(() => [] as Awaited<ReturnType<typeof searchMangaDexAny>>);
        const match = results.find((r) => likelySameTitle(r.mainTitle, title));
        id = match?.id ?? null;
      } else if (source === "mangaupdates") {
        const results = await searchMangaUpdates(title).catch(() => [] as Awaited<ReturnType<typeof searchMangaUpdates>>);
        const match = results.find((r) => likelySameTitle(r.title, title));
        id = match?.id ?? null;
      }
    }

    if (!id) {
      logger.debug({ title, source }, "Fonte alternativa não encontrou correspondência");
      return {
        source,
        fetched: null as FetchResult | null,
        errorKind: undefined as SourceErrorKind | undefined,
        httpStatus: undefined as number | undefined,
      };
    }
    const raw = await fetchChapters(id, source);
    const fetched = isFetchError(raw) ? null : raw;
    logger.debug(
      { title, source, id, value: fetched?.value ?? null, errorKind: isFetchError(raw) ? raw.kind : undefined },
      "Fonte alternativa finalizada",
    );
    return {
      source,
      fetched,
      errorKind: isFetchError(raw) ? raw.kind : undefined,
      httpStatus: isFetchError(raw) ? raw.httpStatus : undefined,
    };
  });

  const comickTask = (async () => {
    logger.debug(
      { title, blocked: isComickBlocked() },
      "Consultando Comick em tarefa isolada",
    );
    let id: string | null = null;
    if (primarySource === "comick") {
      id = includePrimarySource ? manhwaId : null;
    } else if (verifyAllSources) {
      // O diagnóstico administrativo deve validar o Comick mesmo quando a
      // fonte principal da assinatura é outra. O ciclo automático não faz
      // esta busca extra, para não transformar cada rodada em uma rajada de
      // consultas à API protegida.
      const results = await searchComickAny(title).catch(
        () => [] as Awaited<ReturnType<typeof searchComickAny>>,
      );
      const match = results.find((item) =>
        [item.title, ...(item.md_titles ?? []).map((entry) => entry.title)]
          .some((name) => name && likelySameTitle(name, title)),
      );
      id = match?.slug ?? match?.hid ?? null;
    } else {
      // Não pesquisa o Comick durante cada fallback. A busca por título é
      // feita somente ao assinar a obra; depois disso, o slug salvo é usado
      // diretamente para evitar várias requisições desnecessárias.
      logger.debug(
        { title, primarySource },
        "Comick não é fallback desta obra — usando somente a fonte cadastrada",
      );
    }

    if (!id) {
      logger.debug(
        { title, blocked: isComickBlocked() },
        "Comick indisponível nesta rodada — mantendo fontes alternativas",
      );
      return {
        source: "comick" as const,
        fetched: null as FetchResult | null,
        errorKind: isComickBlocked() ? ("http_429" as const) : undefined,
        httpStatus: isComickBlocked() ? 429 : undefined,
      };
    }
    const raw = await fetchChapters(id, "comick");
    const fetched = isFetchError(raw) ? null : raw;
    logger.debug(
      { title, id, value: fetched?.value ?? null, errorKind: isFetchError(raw) ? raw.kind : undefined },
      "Comick finalizado",
    );
    return {
      source: "comick" as const,
      fetched,
      errorKind: isFetchError(raw) ? raw.kind : undefined,
      httpStatus: isFetchError(raw) ? raw.httpStatus : undefined,
    };
  })();

  const settled = await Promise.allSettled([comickTask, ...parallelTasks]);

  const successful: Array<{ source: string; fetched: FetchResult }> = [];

  for (const result of settled) {
    if (result.status === "rejected") {
      // Exceção inesperada na tarefa — não bloqueia as outras fontes
      continue;
    }
    const { source, fetched, errorKind, httpStatus } = result.value;
    // Uma fonte sem ID aplicável à obra não foi consultada. Não a exiba como
    // falha no diagnóstico: o comando administrativo usa ❌ para tentativas
    // reais sem dados, e não para fontes deliberadamente ignoradas.
    if (!fetched && !errorKind && httpStatus == null) continue;
    attempts.push({
      source,
      status: fetched && !fetched.isProxy ? "ok" : "sem_dados",
      value: fetched?.value ?? null,
      selected: false,
      errorKind: errorKind ?? (fetched == null ? "no_data" : undefined),
      httpStatus,
    });
    if (fetched && !fetched.isProxy) {
      successful.push({ source, fetched });
    }
  }

  // Escolhe a fonte com o maior número de capítulos válidos.
  // Em caso de empate, desempata pela prioridade de fonte (comick > mangadex > mangaupdates).
  successful.sort((a, b) => {
    const byChapter = b.fetched.value - a.fetched.value;
    if (byChapter !== 0) return byChapter;
    return (
      MANGA_NOTIFICATION_SOURCE_ORDER.indexOf(a.source) -
      MANGA_NOTIFICATION_SOURCE_ORDER.indexOf(b.source)
    );
  });

  const selected = successful[0] ?? null;
  if (selected) {
    const s = attempts.find((x) => x.source === selected.source);
    if (s) s.selected = true;
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
    if (attempt.status === "ok") continue;
    const kind = attempt.errorKind ?? "no_data";
    const httpInfo = attempt.httpStatus ? ` (HTTP ${attempt.httpStatus})` : "";
    void recordBotError({
      source: "notification_source",
      errorCode: `SOURCE_${kind.toUpperCase().replace(/-/g, "_")}`,
      error: new Error(`${attempt.source}: ${kind}${httpInfo}`),
      context: {
        title,
        primarySource,
        attemptedSource: attempt.source,
        errorKind: kind,
        ...(attempt.httpStatus ? { httpStatus: attempt.httpStatus } : {}),
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
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) return false;

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

    // Modo silencioso: entre 22h e 07h no horário de Brasília (UTC-3) o embed é
    // enviado sem @mencionar os usuários para não acordar ninguém.
    const nowBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hourBrasilia = nowBrasilia.getUTCHours();
    const isSilent = hourBrasilia >= 22 || hourBrasilia < 7;
    // Menciona os inscritos — respeita o limite de 2000 chars do Discord
    const content = mentions.length > 0 && !isSilent ? mentions.join(" ").slice(0, 2000) : undefined;

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
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) return false;

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

/** Detecta se um valor de status indica hiato (pausa temporária). */
function isHiatusStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return s === "on hiatus" || s === "hiatus" || s === "on_hiatus";
}

/** Detecta se um valor de status indica publicação ativa. */
function isPublishingStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return (
    s === "publishing" ||
    s === "releasing" ||
    s === "ongoing" ||
    s === "currently airing" ||
    s === "airing"
  );
}

async function sendStatusChangeNotification(
  client: Client,
  channelId: string,
  title: string,
  siteUrl: string,
  coverUrl: string | null,
  mentions: string[],
  kind: "hiatus" | "return",
): Promise<boolean> {
  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) return false;

    const hourBrasilia = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    ).getHours();
    const isSilent = hourBrasilia >= 22 || hourBrasilia < 7;

    const embed =
      kind === "hiatus"
        ? new EmbedBuilder()
            .setTitle(`⏸️ Em hiato: ${title}`.slice(0, 256))
            .setURL(siteUrl || null)
            .setColor(0xe67e22)
            .setDescription(
              "Este título entrou em **hiato** no MyAnimeList.\n" +
              "Novas notificações serão enviadas quando a publicação retomar."
            )
            .setFooter({ text: "Status atualizado • MyAnimeList" })
        : new EmbedBuilder()
            .setTitle(`▶️ De volta: ${title}`.slice(0, 256))
            .setURL(siteUrl || null)
            .setColor(0x2ecc71)
            .setDescription(
              "Este título **voltou do hiato** e retomou a publicação!\n" +
              "Você será notificado normalmente quando saírem novos capítulos."
            )
            .setFooter({ text: "Status atualizado • MyAnimeList" });

    if (coverUrl) embed.setThumbnail(coverUrl);

    const content =
      mentions.length > 0 && !isSilent ? mentions.join(" ").slice(0, 2000) : undefined;

    await channel.send({ content, embeds: [embed] });
    return true;
  } catch (err) {
    logger.error({ err, channelId, title, kind }, "Erro ao enviar notificação de status");
    return false;
  }
}

/** Detecta se um valor de status indica obra encerrada (independente da capitalização ou fonte). */
function isFinishedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return (
    s === "finished" ||
    s === "finished airing" ||
    s === "finished publishing" ||
    s === "complete" ||
    s === "completed" ||
    s === "cancelled" ||
    s === "discontinued"
  );
}

async function sendFinishedNotification(
  client: Client,
  channelId: string,
  title: string,
  siteUrl: string,
  coverUrl: string | null,
  mentions: string[],
): Promise<boolean> {
  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) return false;

    const hourBrasilia = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    ).getHours();
    const isSilent = hourBrasilia >= 22 || hourBrasilia < 7;

    const embed = new EmbedBuilder()
      .setTitle(`🏁 Obra finalizada: ${title}`.slice(0, 256))
      .setURL(siteUrl || null)
      .setColor(0x9b59b6)
      .setDescription(
        "Esta obra foi marcada como **finalizada** no MyAnimeList.\n" +
        "Todos os capítulos já estão disponíveis!"
      )
      .setFooter({ text: "Status atualizado • MyAnimeList" });

    if (coverUrl) embed.setThumbnail(coverUrl);

    const content =
      mentions.length > 0 && !isSilent ? mentions.join(" ").slice(0, 2000) : undefined;

    await channel.send({ content, embeds: [embed] });
    return true;
  } catch (err) {
    logger.error({ err, channelId, title }, "Erro ao enviar notificação de obra finalizada");
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
            let atLeastOneSentMal = false;
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
              // Não envia embed para guilds sem assinantes deste título
              if (!subscribers.length) continue;
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
              if (sent) { summary.notificationsSent++; atLeastOneSentMal = true; }
            }
            if (atLeastOneSentMal) {
              await db
                .update(capitulosRastreados)
                .set({ lastNotifiedAt: new Date() })
                .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
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

          // Aviso de hiato / retorno — enviado no canal principal com @menção aos assinantes
          const hiatusTransition =
            changedFields.includes("status") &&
            isHiatusStatus(snapshot.status) &&
            !isHiatusStatus(previous?.status);

          const returnTransition =
            changedFields.includes("status") &&
            isPublishingStatus(snapshot.status) &&
            isHiatusStatus(previous?.status);

          for (const kind of (
            [hiatusTransition && "hiatus", returnTransition && "return"] as const
          ).filter(Boolean) as ("hiatus" | "return")[]) {
            logger.info({ title: m.title, kind, newStatus: snapshot.status }, "Transição de status detectada");
            for (const canal of canais) {
              const subscribers = await db
                .select({ discordUserId: assinaturasTable.discordUserId })
                .from(assinaturasTable)
                .where(and(
                  eq(assinaturasTable.manhwaId, m.manhwaId),
                  eq(assinaturasTable.guildId, canal.guildId),
                ));
              if (!subscribers.length) continue;
              const mentions = subscribers.map((s) => `<@${s.discordUserId}>`);
              const sent = await sendStatusChangeNotification(
                client, canal.channelId, m.title, m.siteUrl, m.coverUrl ?? null, mentions, kind,
              );
              if (sent) summary.notificationsSent++;
            }
          }

          // Aviso de obra finalizada — enviado no canal principal com @menção aos assinantes
          const finishedTransition =
            changedFields.includes("status") &&
            isFinishedStatus(snapshot.status) &&
            !isFinishedStatus(previous?.status);

          if (finishedTransition) {
            logger.info({ title: m.title, newStatus: snapshot.status }, "Obra marcada como finalizada");
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
              if (!subscribers.length) continue;
              const mentions = subscribers.map((s) => `<@${s.discordUserId}>`);
              const sent = await sendFinishedNotification(
                client,
                canal.channelId,
                m.title,
                m.siteUrl,
                m.coverUrl ?? null,
                mentions,
              );
              if (sent) summary.notificationsSent++;
            }
          }

          // Pequena pausa entre títulos. O limite específico do Comick fica
          // no ramo da fonte, para não bloquear a fila inteira por 1 minuto.
          await new Promise((r) => setTimeout(r, BETWEEN_TITLES_DELAY_MS));
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
        logger.warn(
          {
            title: m.title,
            source: m.source,
            manhwaId: m.manhwaId,
            attempts: diagnosis.attempts.map((attempt) => ({
              source: attempt.source,
              status: attempt.status,
              errorKind: attempt.errorKind,
              httpStatus: attempt.httpStatus,
            })),
          },
          "Nenhuma fonte retornou dados — seguindo para o próximo título",
        );
        continue;
      }

      const { value: newChapters, isProxy, newManhwaId } = fetched;

      // Slug do Comick mudou por renomeação — corrige nas três tabelas antes de
      // continuar, para que o próximo ciclo não repita a recuperação via busca.
      if (newManhwaId) {
        logger.info({ oldSlug: m.manhwaId, newSlug: newManhwaId, title: m.title }, "Slug do Comick atualizado — persistindo novo identificador");
        await db
          .update(capitulosRastreados)
          .set({ manhwaId: newManhwaId })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        await db
          .update(assinaturasTable)
          .set({ manhwaId: newManhwaId })
          .where(eq(assinaturasTable.manhwaId, m.manhwaId));
        await db
          .update(favoritosTable)
          .set({ manhwaId: newManhwaId })
          .where(eq(favoritosTable.manhwaId, m.manhwaId));
        m.manhwaId = newManhwaId;
      }

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

      // Guard de sanidade: detecta baseline gravado como timestamp Unix (> 100 000).
      // Nenhuma obra realista tem mais de ~10 000 capítulos; se o valor salvo
      // ultrapassa esse limiar, foi corrompido (ex: updatedAt armazenado por engano).
      // Redefine para o valor atual da API sem enviar notificação neste ciclo.
      const CHAPTER_SANITY_MAX = 100_000;
      if (existing.lastChapters != null && existing.lastChapters > CHAPTER_SANITY_MAX) {
        logger.warn(
          { title: m.title, corruptedLastChapters: existing.lastChapters, newChapters },
          "Linha de base parece ser um timestamp — redefinindo para o valor atual da API",
        );
        await db
          .update(capitulosRastreados)
          .set({ lastChapters: newChapters, lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        continue;
      }

      const lastChapters = existing.lastChapters ?? 0;

      // Guard final: garante que NaN/Infinity nunca seja gravado no banco
      // independentemente da fonte que produziu o valor.
      if (!Number.isFinite(newChapters) || newChapters < 0) {
        logger.warn({ title: m.title, newChapters, source: m.source }, "Valor de capítulo inválido ignorado");
        await db
          .update(capitulosRastreados)
          .set({ lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        continue;
      }

      if (newChapters > lastChapters) {
        logger.info({ title: m.title, lastChapters, newChapters, isProxy }, "Novos conteúdos detectados!");

        // isProxy = true significa que estamos rastreando por timestamp (ex: updatedAt do AniList).
        // Não enviamos notificação nesses casos — só atualizamos o DB — para evitar falsos positivos
        // causados por edições de metadados (capa, sinopse, etc.) que também alteram updatedAt.
        let atLeastOneSent = false;
        if (!isProxy) {
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
            // Não envia embed para guilds sem assinantes deste título
            if (!subscribers.length) continue;
            const mentions = subscribers.map((s) => `<@${s.discordUserId}>`);
            const sent = await sendNotification(client, canal.channelId, m.title, newChapters, lastChapters, m.siteUrl, m.coverUrl ?? null, mentions, diagnosis.selectedSource ?? m.source, isProxy);
            if (sent) {
              atLeastOneSent = true;
              summary.notificationsSent++;
            }
          }
        }

        // Só avança a linha de base se: não há canais configurados (modo rastreamento),
        // a fonte é proxy (sem notificação real), ou ao menos uma notificação foi enviada.
        // Isso evita que um canal quebrado ou sem permissão consuma silenciosamente o capítulo.
        if (isProxy || canais.length === 0 || atLeastOneSent) {
          await db
            .update(capitulosRastreados)
            .set({
              lastChapters: newChapters,
              lastChecked: sql`now()`,
              ...(atLeastOneSent ? { lastNotifiedAt: new Date() } : {}),
            })
            .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        } else {
          logger.warn(
            { title: m.title, newChapters, canaisCount: canais.length },
            "Capítulo novo detectado mas nenhuma notificação enviada — linha de base não avançada",
          );
          await db
            .update(capitulosRastreados)
            .set({ lastChecked: sql`now()` })
            .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        }
      } else {
        await db
          .update(capitulosRastreados)
          .set({ lastChecked: sql`now()` })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
      }

      // Pequena pausa entre títulos. Timeout e cooldown das fontes impedem
      // que uma API lenta ou protegida prenda a execução inteira.
      await new Promise((r) => setTimeout(r, BETWEEN_TITLES_DELAY_MS));
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

  logger.info(
    {
      titlesChecked: summary.titlesChecked,
      successfulSources: summary.successfulSources,
      sourcesWithoutData: summary.sourcesWithoutData,
      fallbackUsed: summary.fallbackUsed,
      notificationsSent: summary.notificationsSent,
    },
    "Verificação de capítulos concluída — fila inteira percorrida",
  );
  return summary;
}

export async function runWeeklySummary(client: Client): Promise<void> {
  logger.info("Gerando resumo semanal de notificações...");

  const canais = await db.select().from(notificacaoCanaisTable);
  if (!canais.length) return;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const canal of canais) {
    try {
      // Títulos com notificação enviada na última semana e que tenham assinantes neste servidor
      const rows = await db
        .selectDistinct({
          title: capitulosRastreados.title,
          siteUrl: capitulosRastreados.siteUrl,
          lastChapters: capitulosRastreados.lastChapters,
          lastNotifiedAt: capitulosRastreados.lastNotifiedAt,
        })
        .from(capitulosRastreados)
        .innerJoin(
          assinaturasTable,
          and(
            eq(assinaturasTable.manhwaId, capitulosRastreados.manhwaId),
            eq(assinaturasTable.guildId, canal.guildId),
          ),
        )
        .where(and(isNotNull(capitulosRastreados.lastNotifiedAt), gte(capitulosRastreados.lastNotifiedAt, since)))
        .orderBy(capitulosRastreados.lastNotifiedAt);

      if (!rows.length) continue;

      const lines = rows.map((r) => {
        const cap = r.lastChapters != null ? ` · Cap. ${String(Math.floor(r.lastChapters)).padStart(3, "0")}` : "";
        return `• [${r.title}](${r.siteUrl})${cap}`;
      });

      const channel = getSendableChannel(
        await client.channels.fetch(canal.channelId),
        canal.channelId,
      );
      if (!channel) continue;

      const embed = new EmbedBuilder()
        .setTitle("📅 Resumo semanal — Atualizações da semana")
        .setColor(0x5865f2)
        .setDescription(lines.join("\n").slice(0, 4096))
        .setFooter({ text: `${rows.length} título(s) atualizados nos últimos 7 dias` })
        .setTimestamp();

      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      logger.error({ err, guildId: canal.guildId }, "Erro ao enviar resumo semanal");
    }
  }

  logger.info("Resumo semanal enviado.");
}

/** Retorna o número de ms até o próximo domingo às 10h horário de Brasília. */
function msUntilNextSunday10h(): number {
  const nowBrasilia = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
  const day  = nowBrasilia.getDay();   // 0 = domingo
  const hour = nowBrasilia.getHours();
  const min  = nowBrasilia.getMinutes();
  const sec  = nowBrasilia.getSeconds();

  let daysUntil = (7 - day) % 7;
  if (daysUntil === 0 && (hour > 10 || (hour === 10 && min > 0))) {
    daysUntil = 7; // já passou das 10h do domingo, vai para o próximo
  }

  const msPerDay  = 24 * 60 * 60 * 1000;
  const msElapsed = ((hour * 60 + min) * 60 + sec) * 1000;
  const msTo10h   = 10 * 60 * 60 * 1000;

  return daysUntil * msPerDay + (msTo10h - msElapsed);
}

export function startWeeklyService(client: Client) {
  const runSafe = async () => {
    try {
      await runWeeklySummary(client);
    } catch (err) {
      logger.error({ err }, "Erro no resumo semanal");
    }
  };

  const firstDelay = msUntilNextSunday10h();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  setTimeout(() => {
    void runSafe();
    setInterval(runSafe, WEEK_MS);
  }, firstDelay);

  logger.info(
    { proximoResumoEmHoras: Math.round(firstDelay / 3_600_000) },
    "Resumo semanal agendado",
  );
}

export function startNotificacaoService(client: Client) {
  const runSafe = async () => {
    if (verificationInProgress) {
      logger.warn("Verificação anterior ainda está em andamento — pulando esta rodada");
      return;
    }
    verificationInProgress = true;
    try {
      await runCheck(client);
    } catch (err) {
      logger.error({ err }, "Erro no serviço de notificações");
      void recordBotError({
        source: "notification",
        errorCode: "NOTIFICATION_SERVICE_FAILED",
        error: err,
      });
    } finally {
      verificationInProgress = false;
    }
  };

  setTimeout(runSafe, 60_000);
  setInterval(runSafe, CHECK_INTERVAL_MS);
  logger.info({ intervalHoras: 2 }, "Serviço de notificações iniciado");
}
