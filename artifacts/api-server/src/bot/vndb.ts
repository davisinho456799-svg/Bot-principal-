/**
 * VNDB (Visual Novel Database) — API pública gratuita.
 * Docs: https://api.vndb.org/kana
 * Sem autenticação para consultas públicas.
 */

const BASE = "https://api.vndb.org/kana";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VNDBImage {
  url: string;
  sexual: number; // 0 = safe, 1 = suggestive, 2 = explicit
  violence: number;
}

interface VNDBTitle {
  lang: string;
  title: string;
  official: boolean;
}

interface VNDBDeveloper {
  name: string;
}

interface VNDBTag {
  name: string;
  spoiler: number; // 0 = no spoiler
  rating: number;
}

interface VNDBLanguage {
  lang: string;
}

type VNLength = "very_short" | "short" | "medium" | "long" | "very_long" | null;

interface VNDBRaw {
  id: string;
  title: string;
  alttitle: string | null;
  titles?: VNDBTitle[];
  description: string | null;
  rating: number | null;     // 10–90 scale (multiply ×10 for /100 display)
  votecount: number;
  released: string | null;   // "YYYY-MM-DD" | "YYYY-MM" | "YYYY" | "TBA"
  image: VNDBImage | null;
  developers: VNDBDeveloper[];
  tags: VNDBTag[];
  length: VNLength;
  languages?: VNDBLanguage[];
}

interface VNDBSearchResponse {
  results: VNDBRaw[];
  more: boolean;
  count: number;
}

export interface VNDBResult {
  vnId: string;           // "v1234"
  mainTitle: string;
  altTitle: string | null;
  synonyms: string[];
  description: string | null;
  score: number | null;   // 0–100
  votecount: number;
  released: string | null;
  year: number | null;
  coverUrl: string | null;
  isAdult: boolean;
  tags: string[];
  length: string | null;   // "Muito curto" | "Curto" | "Médio" | "Longo" | "Muito longo"
  developers: string[];
  languages: string[];
  siteUrl: string;
}

// ─── Length labels PT-BR ──────────────────────────────────────────────────────

const LENGTH_LABELS: Record<string, string> = {
  very_short: "Muito curto (<2h)",
  short: "Curto (2–10h)",
  medium: "Médio (10–30h)",
  long: "Longo (30–50h)",
  very_long: "Muito longo (>50h)",
};

// ─── Fields query ─────────────────────────────────────────────────────────────

const FIELDS =
  "title,alttitle,titles.lang,titles.title,titles.official,description," +
  "rating,votecount,released,image.url,image.sexual,image.violence," +
  "developers.name,tags.name,tags.spoiler,length,languages.lang";

// ─── Converter ────────────────────────────────────────────────────────────────

function toVNDBResult(raw: VNDBRaw): VNDBResult {
  const synonyms: string[] = [];
  const seen = new Set<string>([raw.title.toLowerCase()]);
  if (raw.alttitle) seen.add(raw.alttitle.toLowerCase());

  for (const t of raw.titles ?? []) {
    if (t.title && !seen.has(t.title.toLowerCase())) {
      seen.add(t.title.toLowerCase());
      synonyms.push(t.title);
    }
  }

  const score = raw.rating ? Math.round(raw.rating) : null;

  const year = raw.released
    ? parseInt(raw.released.split("-")[0] ?? "", 10) || null
    : null;

  const tags = (raw.tags ?? [])
    .filter((t) => t.spoiler === 0 && t.rating >= 1.5)
    .sort((a, b) => b.rating - a.rating)
    .map((t) => t.name)
    .slice(0, 12);

  const developers = (raw.developers ?? []).map((d) => d.name);
  const languages = (raw.languages ?? []).map((l) => l.lang.toUpperCase());
  const isAdult = raw.image ? raw.image.sexual >= 2 : false;
  const coverUrl = raw.image && raw.image.sexual < 2 ? raw.image.url : null;

  return {
    vnId: raw.id,
    mainTitle: raw.title,
    altTitle: raw.alttitle,
    synonyms,
    description: raw.description ?? null,
    score,
    votecount: raw.votecount,
    released: raw.released,
    year,
    coverUrl,
    isAdult,
    tags,
    length: raw.length ? (LENGTH_LABELS[raw.length] ?? null) : null,
    developers,
    languages,
    siteUrl: `https://vndb.org/${raw.id}`,
  };
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

let lastVNDBCall = 0;
async function throttle(): Promise<void> {
  const wait = 300 - (Date.now() - lastVNDBCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastVNDBCall = Date.now();
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Pesquisa visual novels no VNDB.
 */
export async function searchVNDB(query: string): Promise<VNDBResult[]> {
  await throttle();

  const body = {
    filters: ["search", "=", query],
    fields: FIELDS,
    sort: "searchrank",
    results: 10,
  };

  const res = await fetch(`${BASE}/vn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`VNDB API error: ${res.status}`);

  const json = (await res.json()) as VNDBSearchResponse;
  return (json.results ?? []).map(toVNDBResult);
}

/**
 * Busca uma VN por ID no VNDB.
 */
export async function getVNDBById(id: string): Promise<VNDBResult | null> {
  await throttle();

  const body = {
    filters: ["id", "=", id],
    fields: FIELDS,
    results: 1,
  };

  try {
    const res = await fetch(`${BASE}/vn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as VNDBSearchResponse;
    return json.results[0] ? toVNDBResult(json.results[0]) : null;
  } catch {
    return null;
  }
}

// ─── Adult calendar ───────────────────────────────────────────────────────────

interface VNDBRawWithImage extends VNDBRaw {
  image: VNDBImage | null;
}

/**
 * Busca VNs com conteúdo adulto lançadas no período recente (passado e futuro).
 * Filtra por image.sexual >= 1 (sugestivo ou explícito) para garantir que só
 * apareçam títulos com conteúdo adulto.
 */
export async function fetchVNDBAdultCalendar(monthsBack = 2, monthsAhead = 1): Promise<VNDBResult[]> {
  await throttle();

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead + 1, 0));

  const pad = (n: number) => String(n).padStart(2, "0");
  const fromStr = `${from.getUTCFullYear()}-${pad(from.getUTCMonth() + 1)}-01`;
  const toStr   = `${to.getUTCFullYear()}-${pad(to.getUTCMonth() + 1)}-${pad(to.getUTCDate())}`;

  const body = {
    filters: ["and", ["released", ">=", fromStr], ["released", "<=", toStr]],
    fields: FIELDS,
    sort: "rating",
    reverse: true,
    results: 25,
  };

  try {
    const res = await fetch(`${BASE}/vn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const json = (await res.json()) as { results: VNDBRawWithImage[]; more: boolean };
    return (json.results ?? [])
      .filter((raw) => raw.image != null && raw.image.sexual >= 1)
      .map(toVNDBResult)
      .slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Busca VNs por tags específicas.
 */
export async function searchVNDBByTags(tagNames: string[]): Promise<VNDBResult[]> {
  if (tagNames.length === 0) return [];
  await throttle();

  // First we need tag IDs — VNDB API uses IDs for tag filters
  // Alternatively, use text search + filter locally
  const body = {
    filters: ["search", "=", tagNames.slice(0, 3).join(" ")],
    fields: FIELDS,
    sort: "rating",
    results: 15,
  };

  try {
    const res = await fetch(`${BASE}/vn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as VNDBSearchResponse;
    return (json.results ?? []).map(toVNDBResult);
  } catch {
    return [];
  }
}
