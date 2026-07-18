/**
 * Busca semântica por descrição/sinopse de manhwa.
 *
 * Pipeline:
 * 1. Tradução PT-BR → EN (MyMemory)
 * 2. Extração de conceitos por padrões PT-BR/EN
 * 3. Mapeamento conceito → gêneros/tags AniList
 * 4. Busca multi-fonte em paralelo (AniList por gênero, AniList por keyword,
 *    Jikan, MangaUpdates, MangaDex, Exa como complemento)
 * 5. Pontuação local de similaridade textual: descrição × sinopse da obra
 * 6. Resultado ordenado por % de compatibilidade
 * 7. Aprendizado: salva relações no banco (description_matches)
 */

import {
  searchManhwa,
  searchManhwaByFilters,
  searchManhwaKeywordAny,
  getManhwaById,
  type ManhwaResult,
} from "./anilist.js";
import { searchMangaDex, type MangaDexResult } from "./mangadex.js";
import { searchJikanAny, type JikanResult } from "./jikan.js";
import { searchMangaUpdates, type MangaUpdatesResult } from "./mangaupdates.js";
import { searchByDescription as exaSearchByDescription } from "./exa.js";
import { db } from "@workspace/db";
import { descriptionMatches } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { UnifiedResult } from "./unified.js";

export interface DescriptionSearchResult extends UnifiedResult {
  compatibilityScore: number; // 0–100, porcentagem de compatibilidade
}

// ─── Stopwords ────────────────────────────────────────────────────────────────

const PT_STOPWORDS = new Set([
  "a","o","e","de","do","da","dos","das","em","um","uma","que","se","com","para",
  "por","mas","é","são","na","no","nos","nas","ao","aos","à","às","foi","ser",
  "ter","eles","elas","esse","essa","isso","isto","aquele","aquela","muito","mais",
  "já","também","como","onde","quando","porque","qual","quem","cada","todo","toda",
  "todos","todas","seu","sua","seus","suas","meu","minha","ele","ela","eu","tu",
  "nós","vós","me","te","lhe","nos","vos","lhes","si","este","esta","estes","estas",
  "aqueles","aquelas","num","numa","pelo","pela","pelos","pelas","deste","desta",
  "outro","outra","outros","outras","mesmo","mesma","entre","sobre","após","até",
  "desde","durante","contra","sem","sob","então","assim","ainda","apenas","só",
  "bem","agora","aqui","lá","sempre","nunca","talvez","quase","algo","alguém",
  "nada","ninguém","tudo","nenhum","nenhuma","tão","vez","ser","ter","ir","vir",
  "fazer","dar","ver","saber","poder","dever","mundo","pessoa","pessoas","vida",
  "tempo","lugar","forma","parte","coisa","tipo","modo","homem","mulher","dia",
]);

const EN_STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","can",
  "this","that","these","those","it","its","they","them","their","he","she","his",
  "her","we","our","you","your","my","me","him","who","which","what","when","where",
  "how","if","all","any","both","each","few","more","most","other","some","such",
  "than","then","there","into","through","during","before","after","above","below",
  "between","very","just","about","up","out","around","here","now","so","also",
  "only","even","still","over","under","again","once","s","t","re","ll","ve","not",
  "no","nor","get","got","go","went","came","come","make","made","take","took",
  "give","gave","see","saw","know","knew","say","said","find","found","want","need",
  "use","used","man","woman","world","life","day","time","place","way","thing",
]);

// ─── Tokenização ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const allStop = new Set([...PT_STOPWORDS, ...EN_STOPWORDS]);
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 3 && !allStop.has(w));
}

/**
 * Similaridade textual entre dois textos (0.0 a 1.0).
 * Combina Jaccard (penaliza tamanhos diferentes) com Overlap coefficient
 * (mais justo quando a sinopse é bem maior que a descrição do usuário).
 */
export function computeTextSimilarity(text1: string, text2: string): number {
  const t1 = tokenize(text1);
  const t2 = tokenize(text2);
  if (!t1.length || !t2.length) return 0;

  const set1 = new Set(t1);
  const set2 = new Set(t2);

  let intersection = 0;
  for (const w of set1) {
    if (set2.has(w)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const overlap = intersection / Math.min(set1.size, set2.size);

  return Math.min(1.0, jaccard * 0.35 + overlap * 0.65);
}

// ─── Mapeamento conceito → filtros de API ────────────────────────────────────

interface ApiFilters {
  genres: string[];
  tags: string[];
  keywords: string[];
}

const CONCEPT_PATTERNS: Array<{
  pattern: RegExp;
  genres: string[];
  tags: string[];
  keyword?: string;
}> = [
  {
    pattern: /\b(sem homens|poucos homens|falta.*homens|mundo.*sem.*homens|escassez.*mascul|quase n[ãa]o.*homens|not enough men|no men|few men|lack.*men|men.*scarce|world.*no.*men|shortage.*men)\b/i,
    genres: ["Romance", "Fantasy", "Comedy"],
    tags: ["Female Majority World"],
    keyword: "female majority men shortage women",
  },
  {
    pattern: /\b(reencarna|renasceu|renascer|segunda vida|vida anterior|ressuscit|reborn|reincarn|past life|previous life|nova vida como)\b/i,
    genres: ["Fantasy", "Romance"],
    tags: ["Reincarnation"],
    keyword: "reincarnation second life",
  },
  {
    pattern: /\b(vilã|villain.*lady|antagonista.*livro|personagem.*ruim|destino.*morte|morrerei|bad ending|otome|novel.*world|book.*world|villainess)\b/i,
    genres: ["Fantasy", "Romance", "Comedy"],
    tags: ["Villainess"],
    keyword: "villainess otome game novel",
  },
  {
    pattern: /\b(outro mundo|mundo.*fantasia|mundo.*paralelo|portal.*mundo|transport.*outro|transmigr|isekai|summoned|invocad|acordei.*outro|acordou.*outro)\b/i,
    genres: ["Fantasy", "Action"],
    tags: ["Isekai"],
    keyword: "isekai another world transported summoned",
  },
  {
    pattern: /\b(volta.*passado|retornou.*passado|viagem.*tempo|voltei.*tempo|recomeçar|de novo.*passado|time travel|time loop|went back|returned.*past|loop temporal|reset|regressed)\b/i,
    genres: ["Fantasy", "Drama"],
    tags: ["Time Travel"],
    keyword: "time travel regression reset loop",
  },
  {
    pattern: /\b(sistema|status.*atributo|level.*up|nível.*subiu|dungeon|calabouço|torre.*piso|boss|hunter|caçador|despertar|awakening|player|jogador|habilidade.*especial|skill.*rara)\b/i,
    genres: ["Action", "Fantasy"],
    tags: ["System Administrator", "Hunters"],
    keyword: "system dungeon hunter level awakening",
  },
  {
    pattern: /\b(magia|feitiço|mago|maga|bruxa|bruxo|espada|guerreiro|cavaleiro|knight|wizard|mage|magic|sword|sorcerer|spell)\b/i,
    genres: ["Action", "Fantasy"],
    tags: [],
    keyword: "magic warrior sword fantasy",
  },
  {
    pattern: /\b(nobre|aristocracia|aristocrata|duque|duquesa|conde|condessa|príncipe|princesa|imperador|imperatriz|lorde|noble|duke|duchess|count|prince|princess|emperor|empress|royalty|aristocrat)\b/i,
    genres: ["Fantasy", "Romance", "Drama"],
    tags: ["Royals/Nobles"],
    keyword: "noble royalty aristocrat duke",
  },
  {
    pattern: /\b(harém|harem|rodeado.*mulher|cercado.*mulher|várias.*mulher|muitas.*mulher|surrounded.*women|multiple.*girls|rodeada.*homem|cercada.*homem)\b/i,
    genres: ["Romance", "Comedy"],
    tags: ["Harem", "Reverse Harem"],
    keyword: "harem reverse harem romance",
  },
  {
    pattern: /\b(médico|médica|medicina|curandeiro|curandeira|healer|cura.*mágica|healing|hospital|cirurgião|nurse|enfermeira)\b/i,
    genres: ["Drama"],
    tags: ["Medical"],
    keyword: "medical healer doctor healing",
  },
  {
    pattern: /\b(trauma|abuso|psicológico|manipulação|yandere|obsessão|amnésia|psychological|manipulation|obsession|abuse|mind games)\b/i,
    genres: ["Psychological", "Drama"],
    tags: [],
    keyword: "psychological thriller dark obsession",
  },
  {
    pattern: /\b(apocalipse|fim do mundo|pós.?apocalipse|sobrevivência|monstros.*atacam|invasão.*monstro|apocalypse|post.?apocalyptic|survival|monster.*appear|zombie|zumbi)\b/i,
    genres: ["Action", "Horror"],
    tags: ["Post-Apocalyptic"],
    keyword: "apocalypse survival monsters post-apocalyptic",
  },
  {
    pattern: /\b(demônio|demônia|vampiro|vampira|fantasma|espírito|lobo.*humano|licantropo|demon|vampire|ghost|spirit|werewolf|supernatural|youkai)\b/i,
    genres: ["Supernatural", "Fantasy"],
    tags: [],
    keyword: "supernatural demon vampire ghost",
  },
  {
    pattern: /\b(escola|colégio|universidade|faculdade|ensino.*médio|alun|professor|school|university|college|student|campus|high school)\b/i,
    genres: ["Romance", "Comedy"],
    tags: ["School Life"],
    keyword: "school romance students campus",
  },
  {
    pattern: /\b(culinária|cozinheiro|cozinheira|receita|restaurante|chef|cooking|food|recipe|kitchen|cuisine)\b/i,
    genres: ["Comedy", "Slice of Life"],
    tags: ["Cooking"],
    keyword: "cooking food chef restaurant",
  },
  {
    pattern: /\b(fraco.*forte|mais.*fraco.*mundo|herói.*inútil|weak.*strong|weakest.*powerful|loser.*hero|underdog|rejected.*grows|dismissed.*powerful)\b/i,
    genres: ["Action", "Fantasy"],
    tags: [],
    keyword: "weak hero strongest underdog power",
  },
  {
    pattern: /\b(empresa|negócio|escritório|trabalhador|ceo|overwork|company|business|office worker|salaryman|corporate)\b/i,
    genres: ["Drama", "Slice of Life"],
    tags: ["Business"],
    keyword: "business office company work",
  },
  {
    pattern: /\b(músico|música|cantor|cantora|pintor|artista|dança|dançarino|ídolo|idol|musician|singer|artist|painter|dancer|band)\b/i,
    genres: ["Drama", "Romance"],
    tags: [],
    keyword: "music idol singer artist",
  },
  {
    pattern: /\b(esporte|futebol|basquete|vôlei|tênis|natação|sport|football|soccer|basketball|volleyball|tennis|swimming|athletics)\b/i,
    genres: ["Sports"],
    tags: [],
    keyword: "sports tournament competition",
  },
  {
    pattern: /\b(criança.*adulto|adulto.*criança|corpo.*criança|tornou.*criança|voltou.*criança|regress.*age|child.*body|became.*child|turned.*kid)\b/i,
    genres: ["Fantasy", "Comedy"],
    tags: ["Age Regression"],
    keyword: "age regression child body",
  },
];

export function mapConceptsToFilters(description: string): ApiFilters {
  const genres = new Set<string>();
  const tags = new Set<string>();
  const conceptKeywords: string[] = [];

  for (const concept of CONCEPT_PATTERNS) {
    if (concept.pattern.test(description)) {
      concept.genres.forEach((g) => genres.add(g));
      concept.tags.forEach((t) => tags.add(t));
      if (concept.keyword) conceptKeywords.push(concept.keyword);
    }
  }

  // Extração de palavras-chave por frequência + comprimento
  const rawTokens = tokenize(description);
  const scored = rawTokens
    .filter((w) => w.length >= 4)
    .reduce<Record<string, number>>((acc, w) => { acc[w] = (acc[w] ?? 0) + 1; return acc; }, {});
  const topRaw = Object.entries(scored)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([w]) => w);

  return {
    genres: [...genres].slice(0, 4),
    tags: [...tags].slice(0, 3),
    keywords: [...new Set([...conceptKeywords, ...topRaw])].slice(0, 6),
  };
}

// ─── Hash ────────────────────────────────────────────────────────────────────

function descriptionHash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Tradução ─────────────────────────────────────────────────────────────────

async function translateToEn(text: string): Promise<string> {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 400))}&langpair=auto|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return text;
    const json = (await res.json()) as {
      responseStatus: number;
      responseData: { translatedText: string };
    };
    if (json.responseStatus !== 200) return text;
    const t = json.responseData.translatedText?.trim();
    return t && t.toLowerCase() !== text.toLowerCase() ? t : text;
  } catch {
    return text;
  }
}

// ─── DB: aprendizado ──────────────────────────────────────────────────────────

async function getLearnedBoosts(hash: string): Promise<Map<string, number>> {
  try {
    const rows = await db.select().from(descriptionMatches).where(eq(descriptionMatches.descriptionHash, hash));
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.canonicalTitle.toLowerCase(), r.similarityScore);
    return map;
  } catch {
    return new Map();
  }
}

async function saveLearnedMatches(hash: string, snippet: string, results: DescriptionSearchResult[]): Promise<void> {
  for (const r of results.slice(0, 5)) {
    if (r.compatibilityScore < 15) continue;
    try {
      await db
        .insert(descriptionMatches)
        .values({
          descriptionHash: hash,
          descriptionSnippet: snippet.slice(0, 100),
          canonicalTitle: r.mainTitle,
          source: r.source,
          similarityScore: r.compatibilityScore / 100,
        })
        .onConflictDoUpdate({
          target: [descriptionMatches.descriptionHash, descriptionMatches.canonicalTitle],
          set: { similarityScore: r.compatibilityScore / 100, createdAt: new Date() },
        });
    } catch { /* non-fatal */ }
  }
}

// ─── Converters locais (para evitar dependência circular com unified.ts) ───────

function aniToUnified(m: ManhwaResult): UnifiedResult {
  return {
    source: "anilist",
    id: String(m.id),
    mainTitle: m.title.english ?? m.title.romaji ?? m.title.native ?? "Sem título",
    nativeTitle: m.title.native ?? null,
    romajiTitle: m.title.romaji ?? null,
    synonyms: m.synonyms ?? [],
    description: m.description ?? null,
    coverUrl: m.coverImage.large,
    accentColor: m.coverImage.color ? parseInt(m.coverImage.color.replace("#", ""), 16) : 0x7b68ee,
    score: m.averageScore,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.startDate?.year ?? null,
    ptBrUrl: null,
  };
}

function mdToUnified(m: MangaDexResult): UnifiedResult {
  return {
    source: "mangadex",
    id: m.id,
    mainTitle: m.mainTitle,
    nativeTitle: m.nativeTitle,
    romajiTitle: m.romajiTitle,
    synonyms: m.synonyms,
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0xe6813a,
    score: null,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
  };
}

function jikanToUnified(m: JikanResult): UnifiedResult {
  return {
    source: "jikan",
    id: String(m.malId),
    mainTitle: m.mainTitle,
    nativeTitle: m.japaneseTitle,
    romajiTitle: null,
    synonyms: m.synonyms,
    description: null,
    coverUrl: m.coverUrl,
    accentColor: 0x2e51a2,
    score: m.score,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
  };
}

function muToUnified(m: MangaUpdatesResult): UnifiedResult {
  return {
    source: "mangaupdates",
    id: m.id,
    mainTitle: m.title,
    nativeTitle: null,
    romajiTitle: null,
    synonyms: [],
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0x1565c0,
    score: m.score,
    genres: m.genres,
    chapters: null,
    status: m.status,
    siteUrl: m.url,
    year: m.year,
    ptBrUrl: null,
  };
}

// ─── Função principal ─────────────────────────────────────────────────────────

export async function searchByDescriptionEnhanced(
  description: string
): Promise<DescriptionSearchResult[]> {
  const hash = descriptionHash(description);

  // Boost de aprendizado: títulos que já foram encontrados antes com esta descrição
  const learnedBoosts = await getLearnedBoosts(hash);

  // Tradução e extração de filtros em paralelo
  const [translatedEn, filters] = await Promise.all([
    translateToEn(description),
    Promise.resolve(mapConceptsToFilters(description)),
  ]);

  // Queries de busca derivadas
  const keywordQuery = filters.keywords.slice(0, 3).join(" ") || translatedEn.slice(0, 60);
  const translatedQuery = translatedEn !== description ? translatedEn.slice(0, 60) : keywordQuery;

  // Busca em paralelo em todas as fontes
  const [anilistKw, anilistFilter, anilistEn, jikanRaw, muRaw, mdRaw, exaRaw] =
    await Promise.allSettled([
      searchManhwa(description.slice(0, 50)),
      filters.genres.length > 0 || filters.tags.length > 0
        ? searchManhwaByFilters(filters.genres, filters.tags)
        : Promise.resolve([] as ManhwaResult[]),
      translatedEn !== description
        ? searchManhwaKeywordAny(translatedQuery)
        : Promise.resolve([] as ManhwaResult[]),
      searchJikanAny(keywordQuery),
      searchMangaUpdates(keywordQuery),
      searchMangaDex(translatedQuery),
      exaSearchByDescription(description),
    ]);

  // Agrega e deduplica todos os candidatos
  const seen = new Set<string>();
  const candidates: Array<{ result: UnifiedResult; synopsis: string }> = [];

  function norm(t: string) { return t.toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function add(r: UnifiedResult) {
    const key = norm(r.mainTitle);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ result: r, synopsis: r.description ?? "" });
  }

  if (anilistKw.status === "fulfilled") anilistKw.value.map(aniToUnified).forEach(add);
  if (anilistFilter.status === "fulfilled") anilistFilter.value.map(aniToUnified).forEach(add);
  if (anilistEn.status === "fulfilled") anilistEn.value.map(aniToUnified).forEach(add);
  if (jikanRaw.status === "fulfilled") jikanRaw.value.map(jikanToUnified).forEach(add);
  if (muRaw.status === "fulfilled") muRaw.value.map(muToUnified).forEach(add);
  if (mdRaw.status === "fulfilled") mdRaw.value.map(mdToUnified).forEach(add);

  // Exa: extrai IDs AniList e busca detalhes para melhor sinopse
  if (exaRaw.status === "fulfilled") {
    const aniIds = exaRaw.value
      .map((h) => h.anilistId)
      .filter((id): id is number => id !== null)
      .slice(0, 4);
    if (aniIds.length > 0) {
      const fetched = await Promise.allSettled(aniIds.map(getManhwaById));
      for (const res of fetched) {
        if (res.status === "fulfilled" && res.value) add(aniToUnified(res.value));
      }
    }
  }

  // ─── Pontuação de compatibilidade ───────────────────────────────────────────

  const scored: DescriptionSearchResult[] = candidates.map(({ result, synopsis }) => {
    // Similaridade textual: texto original PT vs sinopse
    const simPt = computeTextSimilarity(description, synopsis);
    // Texto traduzido EN vs sinopse (captura termos EN na sinopse em inglês)
    const simEn = translatedEn !== description
      ? computeTextSimilarity(translatedEn, synopsis)
      : 0;

    // Boost de gênero: gêneros previstos que batem com os da obra
    let genreBoost = 0;
    if (filters.genres.length > 0 && result.genres.length > 0) {
      const resultGenres = new Set(result.genres.map((g) => g.toLowerCase()));
      const hits = filters.genres.filter((g) => resultGenres.has(g.toLowerCase())).length;
      genreBoost = (hits / filters.genres.length) * 0.18;
    }

    // Boost de aprendizado histórico
    const learnedBoost = learnedBoosts.get(result.mainTitle.toLowerCase()) ?? 0;

    const rawScore = Math.max(simPt, simEn) + genreBoost + learnedBoost * 0.25;
    const compatibilityScore = Math.min(100, Math.round(rawScore * 100));

    return { ...result, compatibilityScore };
  });

  // Ordena por compatibilidade decrescente
  scored.sort((a, b) => b.compatibilityScore - a.compatibilityScore);

  const hasGoodResults = scored.some((r) => r.compatibilityScore >= 20);
  const final = hasGoodResults
    ? scored.filter((r) => r.compatibilityScore >= 5).slice(0, 10)
    : scored.slice(0, 8);

  void saveLearnedMatches(hash, description, final);

  return final;
}
