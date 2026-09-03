/**
 * Funções puras do serviço de notificação — sem dependências externas (DB, Discord).
 * Isoladas aqui para permitir testes unitários sem mocks.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface FetchResult {
  value: number;
  /** true = valor é timestamp/proxy, não um número de capítulos real */
  isProxy: boolean;
  /**
   * Preenchido somente quando o slug do Comick mudou (obra renomeada) e foi
   * recuperado via busca. O chamador deve persistir o novo slug nas tabelas.
   */
  newManhwaId?: string;
}

export type SourceErrorKind =
  | "http_404"
  | "http_403"
  | "http_429"
  | "http_5xx"
  | "http_other"
  | "timeout"
  | "invalid_response"
  | "no_data";

/** Objeto retornado por fetchChapters quando a falha é identificada. */
export interface FetchError {
  readonly _err: true;
  kind: SourceErrorKind;
  httpStatus?: number;
}

// ─── Factories e guards ───────────────────────────────────────────────────────

export function fetchError(kind: SourceErrorKind, httpStatus?: number): FetchError {
  return { _err: true, kind, httpStatus };
}

export function isFetchError(r: FetchResult | FetchError | null): r is FetchError {
  return r !== null && "_err" in r;
}

// ─── Classificação de erros ───────────────────────────────────────────────────

export function classifyHttpStatus(status: number): SourceErrorKind {
  if (status === 404) return "http_404";
  if (status === 403) return "http_403";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  return "http_other";
}

export function classifyException(err: unknown): SourceErrorKind {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    if (err instanceof SyntaxError) return "invalid_response";
  }
  return "http_other";
}

// ─── Normalização de capítulos ────────────────────────────────────────────────

/**
 * Normaliza um valor de capítulo vindo de uma API externa.
 *
 * Aceita number ou string numérica (incluindo decimais como "150.5").
 * Rejeita NaN, Infinity, valores negativos e strings não-numéricas
 * (ex: "EX", "Oneshot", "SP") — retorna null nesses casos.
 *
 * Garante que nenhuma fonte injete NaN no banco de dados ou distorça
 * a seleção de fonte mais atualizada.
 */
export function normalizeChapterValue(raw: unknown): number | null {
  const n = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : null;
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return n;
}

// ─── Comparações de snapshot MAL ──────────────────────────────────────────────

export function normalizeSynopsis(value: string | null): string | null {
  return value?.replace(/\s+/g, " ").trim() || null;
}

export function sameNullableNumber(a: number | null, b: number | null): boolean {
  return a === b || (a == null && b == null);
}

export function sameNullableText(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Cria uma chave estável para uma atualização de capítulo.
 *
 * O mesmo título pode existir no rastreador com IDs diferentes (por exemplo,
 * quando alguém assinou a obra em mais de uma fonte). Nesse caso, o evento
 * lógico é o mesmo para o Discord: um título, um capítulo e um canal.
 */
export function notificationEventKey(
  channelId: string,
  title: string,
  newChapters: number,
): string {
  const normalizedTitle = title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");

  const safeTitle = encodeURIComponent(normalizedTitle || title.trim().toLowerCase());
  return `${channelId}|${safeTitle}|${newChapters}`;
}
