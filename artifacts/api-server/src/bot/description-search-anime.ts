/**
 * Busca semântica de anime por descrição em português.
 * Mapeia conceitos PT-BR → gêneros/tags AniList → busca por filtros.
 * Inspirado em description-search.ts mas adaptado para anime.
 */

import { searchAnime, searchAnimeByFilters } from "./anilist.js";
import { searchJikanAnimeAny } from "./jikan.js";
import { searchKitsu } from "./kitsu.js";

// ─── Padrões PT-BR → filtros AniList ─────────────────────────────────────────

interface AnimeConcept {
  ptBrTerms: RegExp[];
  genres: string[];
  tags: string[];
  englishKeywords: string[];
  weight: number; // 1–3, maior = conceito mais específico
}

const ANIME_CONCEPT_PATTERNS: AnimeConcept[] = [
  // ── Isekai / Reencarnação ──────────────────────────────────────────────────
  {
    ptBrTerms: [
      /isekai/i, /outro mundo/i, /transportado para/i, /renascid[ao]/i,
      /reencarna/i, /portal.*mundo/i, /invocad[ao]/i, /summonado/i,
    ],
    genres: ["Fantasy", "Adventure"],
    tags: ["Isekai", "Reincarnation"],
    englishKeywords: ["isekai", "reincarnation", "another world", "transported"],
    weight: 3,
  },
  // ── Sistema de Status / RPG / Game ────────────────────────────────────────
  {
    ptBrTerms: [
      /sistema de status/i, /janela de status/i, /level up/i, /nivelamento/i,
      /rpg/i, /video game/i, /jogo.*mundo/i, /mundo.*jogo/i, /habilidade/i,
      /ponto.*habilidade/i, /classe/i, /rang[oe]/i,
    ],
    genres: ["Action", "Fantasy", "Adventure"],
    tags: ["Video Game", "Isekai", "RPG", "Game Elements"],
    englishKeywords: ["status", "level up", "rpg", "game", "skill", "class"],
    weight: 3,
  },
  // ── Regressão no tempo / Viagem temporal ─────────────────────────────────
  {
    ptBrTerms: [
      /regrid[ei]/i, /volta no tempo/i, /viagem.*temp/i, /loop temporal/i,
      /repetindo o dia/i, /reinicia/i, /segunda chance/i, /retornou ao passado/i,
    ],
    genres: ["Drama", "Fantasy"],
    tags: ["Time Travel", "Time Loop", "Second Chance"],
    englishKeywords: ["time travel", "regression", "time loop", "second chance"],
    weight: 3,
  },
  // ── Mecha ─────────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /mecha/i, /rob[ôo]\b/i, /robo gigante/i, /pilotando.*rob[ôo]/i,
      /exoesqueleto/i, /armadura rob[ôo]/i, /mech/i,
    ],
    genres: ["Action", "Sci-Fi"],
    tags: ["Mecha"],
    englishKeywords: ["mecha", "robot", "giant robot", "pilot"],
    weight: 3,
  },
  // ── Shounen / Aventura de crescimento ────────────────────────────────────
  {
    ptBrTerms: [
      /shounen/i, /herói.*cresc/i, /tornando.*mais forte/i, /poder.*amizade/i,
      /nunca desist/i, /superar.*limite/i, /mais forte do que/i,
    ],
    genres: ["Action", "Adventure"],
    tags: ["Shounen"],
    englishKeywords: ["shounen", "growing stronger", "friendship", "determination"],
    weight: 2,
  },
  // ── Magical Girl / Mahou Shoujo ───────────────────────────────────────────
  {
    ptBrTerms: [
      /magical girl/i, /mahou shoujo/i, /guerreira m[áa]gica/i,
      /menina.*transforma/i, /transforma.*poderes/i, /garota.*m[áa]gica/i,
    ],
    genres: ["Fantasy", "Action"],
    tags: ["Mahou Shoujo", "Magical Girl", "Transformation"],
    englishKeywords: ["magical girl", "mahou shoujo", "transformation"],
    weight: 3,
  },
  // ── Slice of Life / Cotidiano ─────────────────────────────────────────────
  {
    ptBrTerms: [
      /slice of life/i, /vida cotidiana/i, /dia a dia/i, /rotina/i,
      /vida simples/i, /momentos do dia/i, /colegial.*cotidiano/i, /tranquilo/i,
    ],
    genres: ["Slice of Life"],
    tags: [],
    englishKeywords: ["slice of life", "daily life", "everyday"],
    weight: 2,
  },
  // ── Romance / Amor ────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /romance/i, /amor/i, /se apaixona/i, /relacionamento/i, /namoro/i,
      /ama[nt][ae]/i, /casal/i, /declaração de amor/i, /crush/i, /paixão/i,
    ],
    genres: ["Romance"],
    tags: [],
    englishKeywords: ["romance", "love", "relationship", "couple"],
    weight: 2,
  },
  // ── Harém ─────────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /har[eé]m/i, /rodeado.*garotas/i, /rodeado.*meninas/i,
      /garotas.*apaixonadas/i, /muitas.*garotas/i,
    ],
    genres: ["Romance", "Comedy"],
    tags: ["Harem", "Reverse Harem"],
    englishKeywords: ["harem", "surrounded by girls"],
    weight: 3,
  },
  // ── Escola / Colégio / Academia ───────────────────────────────────────────
  {
    ptBrTerms: [
      /escola/i, /col[eé]gio/i, /academia/i, /estudante/i, /aluno/i,
      /professor/i, /colegial/i, /escola.*magia/i, /high school/i,
    ],
    genres: ["School"],
    tags: ["School", "High School", "Academy"],
    englishKeywords: ["school", "academy", "student", "high school"],
    weight: 2,
  },
  // ── Vampiro ───────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /vampiro/i, /sugador.*sangue/i, /se torna vampiro/i, /clan.*vampiro/i,
      /imortal.*vampiro/i,
    ],
    genres: ["Horror", "Fantasy"],
    tags: ["Vampire"],
    englishKeywords: ["vampire", "blood", "immortal"],
    weight: 3,
  },
  // ── Demônio / Rei Demônio ─────────────────────────────────────────────────
  {
    ptBrTerms: [
      /dem[ôo]nio/i, /rei.*dem[ôo]nio/i, /lord.*dem[ôo]nio/i, /lorde sombrio/i,
      /diabo/i, /senhor.*trevas/i, /reencarna.*dem[ôo]nio/i,
    ],
    genres: ["Fantasy", "Action"],
    tags: ["Demons", "Demon", "Demon Lord"],
    englishKeywords: ["demon", "demon king", "demon lord"],
    weight: 3,
  },
  // ── Zumbi / Apocalipse ────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /zumbi/i, /apocalipse/i, /pós.?apocal/i, /fim do mundo/i,
      /sobreviver.*caos/i, /infect/i, /vírus.*espalhando/i,
    ],
    genres: ["Horror", "Action"],
    tags: ["Zombie", "Survival", "Post-Apocalyptic"],
    englishKeywords: ["zombie", "apocalypse", "survival", "post-apocalyptic"],
    weight: 3,
  },
  // ── Horror / Terror ───────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /horror/i, /terror/i, /assustador/i, /amaldiçoado/i, /maldição/i,
      /fantasma/i, /espírito maligno/i, /sobrenatural/i,
    ],
    genres: ["Horror"],
    tags: ["Horror", "Supernatural"],
    englishKeywords: ["horror", "terror", "ghost", "curse", "supernatural"],
    weight: 2,
  },
  // ── Psicológico / Thriller ────────────────────────────────────────────────
  {
    ptBrTerms: [
      /psicológico/i, /thriller/i, /suspense/i, /mente/i, /manipula/i,
      /jogo mental/i, /sanidade/i, /perturbador/i,
    ],
    genres: ["Psychological"],
    tags: ["Psychological"],
    englishKeywords: ["psychological", "thriller", "mind games", "manipulation"],
    weight: 2,
  },
  // ── Mistério / Detetive ───────────────────────────────────────────────────
  {
    ptBrTerms: [
      /mist[eé]rio/i, /detetive/i, /investigad/i, /assassinato/i, /crime/i,
      /caso para resolver/i, /assassin[ao]/i, /serial killer/i,
    ],
    genres: ["Mystery"],
    tags: ["Detective", "Crime", "Mystery"],
    englishKeywords: ["mystery", "detective", "murder", "crime"],
    weight: 2,
  },
  // ── Esporte ───────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /esporte/i, /futebol/i, /basquete/i, /voleibol/i, /tênis/i,
      /boxe/i, /natação/i, /beisebol/i, /time.*esporte/i, /competição.*esport/i,
    ],
    genres: ["Sports"],
    tags: ["Sports"],
    englishKeywords: ["sports", "soccer", "basketball", "volleyball", "competition"],
    weight: 2,
  },
  // ── Música / Banda / Idol ─────────────────────────────────────────────────
  {
    ptBrTerms: [
      /música/i, /banda/i, /idol/i, /cantor/i, /cantora/i, /grupo musical/i,
      /concerto/i, /palco/i, /sonho musical/i,
    ],
    genres: ["Music"],
    tags: ["Music"],
    englishKeywords: ["music", "band", "idol", "singer", "concert"],
    weight: 2,
  },
  // ── Culinária ─────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /culin[aá]ria/i, /cozinheiro/i, /cozinheira/i, /chef/i, /receita/i,
      /restaurante/i, /comida/i, /batalha.*culin/i,
    ],
    genres: ["Slice of Life"],
    tags: ["Cooking", "Food"],
    englishKeywords: ["cooking", "chef", "food", "restaurant", "culinary"],
    weight: 2,
  },
  // ── Militar / Guerra ─────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /militar/i, /guerra/i, /batalha/i, /soldado/i, /exércit/i, /combate/i,
      /arma.*guerra/i, /campo de batalha/i, /estratégia.*guerra/i,
    ],
    genres: ["Action"],
    tags: ["Military", "War"],
    englishKeywords: ["military", "war", "soldier", "battle", "combat"],
    weight: 2,
  },
  // ── Histórico / Samurai / Era ─────────────────────────────────────────────
  {
    ptBrTerms: [
      /histór/i, /samurai/i, /espadachim/i, /ninja/i, /feudal/i,
      /era meiji/i, /período.*edo/i, /antigo/i, /guerreiro antigo/i,
    ],
    genres: ["Action"],
    tags: ["Historical", "Samurai", "Ninja"],
    englishKeywords: ["historical", "samurai", "ninja", "feudal", "ancient"],
    weight: 2,
  },
  // ── Sci-Fi / Cyberpunk ────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /ciberpunk/i, /cyberpunk/i, /futuro/i, /tecnologia.*avançada/i,
      /implante/i, /hacker/i, /inteligência artificial/i, /ia\b/i,
    ],
    genres: ["Sci-Fi"],
    tags: ["Cyberpunk", "Artificial Intelligence", "Future"],
    englishKeywords: ["cyberpunk", "future", "AI", "artificial intelligence", "hacker"],
    weight: 2,
  },
  // ── Espaço / Ficção Científica ────────────────────────────────────────────
  {
    ptBrTerms: [
      /espaço/i, /galáxia/i, /nave espacial/i, /alien/i, /extraterrestre/i,
      /universo/i, /planeta/i, /cosmos/i, /astronauta/i,
    ],
    genres: ["Sci-Fi", "Adventure"],
    tags: ["Space", "Aliens"],
    englishKeywords: ["space", "galaxy", "spacecraft", "alien", "universe"],
    weight: 2,
  },
  // ── Superpoder / Super-Herói ──────────────────────────────────────────────
  {
    ptBrTerms: [
      /superpoder/i, /super herói/i, /super-her[oó]i/i, /poder especial/i,
      /habilidade especial/i, /o mais poderoso/i, /overpowered/i, /op\b/i,
    ],
    genres: ["Action"],
    tags: ["Super Power", "Overpowered Main Characters"],
    englishKeywords: ["superpower", "superhero", "overpowered", "special ability"],
    weight: 2,
  },
  // ── Boys Love (BL / Yaoi) ─────────────────────────────────────────────────
  {
    ptBrTerms: [
      /boys love/i, /yaoi/i, /bl\b/i, /romance.*dois rapazes/i,
      /rapazes.*se apaixonam/i, /amor.*masculino/i,
    ],
    genres: ["Romance"],
    tags: ["Boys Love", "BL"],
    englishKeywords: ["boys love", "yaoi", "bl"],
    weight: 3,
  },
  // ── Girls Love (GL / Yuri) ────────────────────────────────────────────────
  {
    ptBrTerms: [
      /girls love/i, /yuri/i, /gl\b/i, /romance.*duas garotas/i,
      /garotas.*se apaixonam/i, /amor.*feminino/i,
    ],
    genres: ["Romance"],
    tags: ["Girls Love", "Yuri"],
    englishKeywords: ["girls love", "yuri", "gl"],
    weight: 3,
  },
  // ── Distopia / Pós-Apocalíptico ───────────────────────────────────────────
  {
    ptBrTerms: [
      /distopia/i, /governo.*opressor/i, /sociedade.*controlada/i,
      /rebelião/i, /revolução.*tirania/i, /sistema.*corrompid/i,
    ],
    genres: ["Sci-Fi"],
    tags: ["Dystopia", "Post-Apocalyptic", "Survival"],
    englishKeywords: ["dystopia", "oppression", "rebellion", "revolution"],
    weight: 2,
  },
  // ── Aventura / Exploração ─────────────────────────────────────────────────
  {
    ptBrTerms: [
      /aventura/i, /exploração/i, /expedição/i, /dungeon/i, /calabouço/i,
      /guilda.*aventureiro/i, /aventureiro/i, /missão/i,
    ],
    genres: ["Adventure", "Fantasy"],
    tags: ["Dungeon", "Guild"],
    englishKeywords: ["adventure", "dungeon", "guild", "quest", "expedition"],
    weight: 1,
  },
  // ── Dragão / Criaturas ────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /drag[ãa]o/i, /monstro/i, /criatura/i, /besta/i, /domar.*criatura/i,
      /invocar.*criaturas/i, /familiares/i,
    ],
    genres: ["Fantasy", "Action"],
    tags: ["Dragons", "Monster", "Creature"],
    englishKeywords: ["dragon", "monster", "creature", "beast"],
    weight: 2,
  },
  // ── Trabalho / Escritório ─────────────────────────────────────────────────
  {
    ptBrTerms: [
      /trabalho/i, /escritório/i, /carreira/i, /corporativo/i,
      /profissional/i, /empresa/i, /emprego/i,
    ],
    genres: ["Slice of Life"],
    tags: ["Workplace"],
    englishKeywords: ["work", "office", "career", "corporate"],
    weight: 1,
  },
  // ── Magia / Fantasia ──────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /magia/i, /mago/i, /feiticeiro/i, /feitiço/i, /encantamento/i,
      /bruxo/i, /conjurador/i, /mundo.*magia/i,
    ],
    genres: ["Fantasy"],
    tags: ["Magic", "Sorcery"],
    englishKeywords: ["magic", "wizard", "sorcerer", "spell", "enchantment"],
    weight: 1,
  },
  // ── Comédia ───────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /com[eé]dia/i, /engraçado/i, /hilar/i, /gag/i, /slapstick/i,
      /situação cômica/i, /humor/i,
    ],
    genres: ["Comedy"],
    tags: [],
    englishKeywords: ["comedy", "funny", "humor", "gag"],
    weight: 1,
  },
  // ── Drama ─────────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /drama/i, /emocionante/i, /trágico/i, /tragédia/i, /tocante/i,
      /história triste/i, /chora/i, /sofrimento/i,
    ],
    genres: ["Drama"],
    tags: [],
    englishKeywords: ["drama", "tragedy", "emotional", "sad"],
    weight: 1,
  },
  // ── Artes Marciais ────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /artes marciais/i, /kung fu/i, /karatê/i, /caratê/i, /judô/i,
      /luta.*mão/i, /boxe/i, /wrestling/i, /torneio.*luta/i,
    ],
    genres: ["Action"],
    tags: ["Martial Arts", "Fighting"],
    englishKeywords: ["martial arts", "kung fu", "karate", "fighting"],
    weight: 2,
  },
  // ── Alquimia ──────────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /alquimia/i, /alquimista/i, /poção/i, /transmutação/i,
      /pedra filosofal/i,
    ],
    genres: ["Fantasy", "Action"],
    tags: ["Alchemy"],
    englishKeywords: ["alchemy", "alchemist", "potion", "philosopher's stone"],
    weight: 3,
  },
  // ── Médico / Saúde ────────────────────────────────────────────────────────
  {
    ptBrTerms: [
      /m[eé]dic/i, /hospital/i, /cirurgi/i, /enfermeir/i, /paciente/i,
      /doutor/i, /cura.*do[eé]nça/i,
    ],
    genres: ["Drama"],
    tags: ["Medical"],
    englishKeywords: ["medical", "doctor", "hospital", "surgery", "nurse"],
    weight: 2,
  },
];

// ─── Extração de conceitos ────────────────────────────────────────────────────

export interface AnimeConcepts {
  genres: string[];
  tags: string[];
  englishKeywords: string[];
  matchedPatterns: number;
}

export function extractAnimeConcepts(ptBrDescription: string): AnimeConcepts {
  const genreSet = new Set<string>();
  const tagSet = new Set<string>();
  const keywordSet = new Set<string>();
  let matchedPatterns = 0;

  for (const pattern of ANIME_CONCEPT_PATTERNS) {
    const matched = pattern.ptBrTerms.some((re) => re.test(ptBrDescription));
    if (!matched) continue;

    matchedPatterns++;
    // Adiciona com peso — gêneros/tags mais específicos (weight=3) entram na frente
    for (const g of pattern.genres) genreSet.add(g);
    for (const t of pattern.tags) tagSet.add(t);
    for (const k of pattern.englishKeywords) keywordSet.add(k);
  }

  return {
    genres: [...genreSet].slice(0, 5),
    tags: [...tagSet].slice(0, 5),
    englishKeywords: [...keywordSet].slice(0, 8),
    matchedPatterns,
  };
}

// ─── Busca principal ──────────────────────────────────────────────────────────

export interface AnimeDescriptionCandidate {
  id: string;
  source: "anilist-anime" | "jikan" | "kitsu";
  mainTitle: string;
  synonyms: string[];
  description: string | null;
  genres: string[];
  coverUrl: string | null;
  score: number | null;
  status: string | null;
  siteUrl: string;
  year: number | null;
  episodes: number | null;
  // Raw data para conversão em UnifiedResult
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

/**
 * Busca animes com base numa descrição PT-BR, usando padrões de conceito
 * para mapear para gêneros/tags AniList e retornando candidatos ranqueados.
 */
export async function searchAnimeByConceptsPtBr(
  description: string
): Promise<AnimeDescriptionCandidate[]> {
  const concepts = extractAnimeConcepts(description);

  const queries: Promise<AnimeDescriptionCandidate[]>[] = [];

  // 1. AniList por gêneros/tags (se conceitos detectados)
  if (concepts.genres.length > 0 || concepts.tags.length > 0) {
    queries.push(
      searchAnimeByFilters(concepts.genres, concepts.tags)
        .then((results) =>
          results.map((r) => ({
            id: String(r.id),
            source: "anilist-anime" as const,
            mainTitle: r.title.english ?? r.title.romaji ?? "?",
            synonyms: r.synonyms ?? [],
            description: r.description ?? null,
            genres: r.genres,
            coverUrl: r.coverImage?.large ?? null,
            score: r.averageScore,
            status: r.status,
            siteUrl: r.siteUrl,
            year: r.startDate?.year ?? null,
            episodes: r.episodes ?? null,
            raw: r,
          }))
        )
        .catch(() => [])
    );
  }

  // 2. AniList por keywords em inglês (busca textual)
  if (concepts.englishKeywords.length > 0) {
    for (const kw of concepts.englishKeywords.slice(0, 3)) {
      queries.push(
        searchAnime(kw)
          .then((results) =>
            results.map((r) => ({
              id: String(r.id),
              source: "anilist-anime" as const,
              mainTitle: r.title.english ?? r.title.romaji ?? "?",
              synonyms: r.synonyms ?? [],
              description: r.description ?? null,
              genres: r.genres,
              coverUrl: r.coverImage?.large ?? null,
              score: r.averageScore,
              status: r.status,
              siteUrl: r.siteUrl,
              year: r.startDate?.year ?? null,
              episodes: r.episodes ?? null,
              raw: r,
            }))
          )
          .catch(() => [])
      );
    }
  }

  // 3. Jikan por keywords
  if (concepts.englishKeywords.length > 0) {
    const mainKw = concepts.englishKeywords.slice(0, 2).join(" ");
    queries.push(
      searchJikanAnimeAny(mainKw)
        .then((results) =>
          results.map((r) => ({
            id: String(r.malId),
            source: "jikan" as const,
            mainTitle: r.mainTitle,
            synonyms: r.synonyms,
            description: r.synopsis ?? null,
            genres: r.genres,
            coverUrl: r.coverUrl,
            score: r.score,
            status: r.status,
            siteUrl: r.siteUrl,
            year: r.year,
            episodes: r.episodes ?? null,
            raw: r,
          }))
        )
        .catch(() => [])
    );
  }

  // 4. Kitsu por keyword principal
  if (concepts.englishKeywords.length > 0) {
    queries.push(
      searchKitsu(concepts.englishKeywords[0]!)
        .then((results) =>
          results.map((r) => ({
            id: r.kitsuId,
            source: "kitsu" as const,
            mainTitle: r.mainTitle,
            synonyms: r.synonyms,
            description: r.synopsis ?? null,
            genres: [],
            coverUrl: r.coverUrl,
            score: r.score,
            status: r.status,
            siteUrl: r.siteUrl,
            year: r.year,
            episodes: r.episodes ?? null,
            raw: r,
          }))
        )
        .catch(() => [])
    );
  }

  const allBatches = await Promise.allSettled(queries);
  const seen = new Map<string, AnimeDescriptionCandidate>();

  for (const batch of allBatches) {
    if (batch.status !== "fulfilled") continue;
    for (const c of batch.value) {
      const key = `${c.source}:${c.id}`;
      if (!seen.has(key)) seen.set(key, c);
    }
  }

  return [...seen.values()];
}

// ─── Score de compatibilidade ─────────────────────────────────────────────────

/**
 * Pontua um candidato com base nos conceitos detectados da descrição PT-BR.
 * Retorna 0–100.
 */
export function scoreAnimeCandidate(
  candidate: AnimeDescriptionCandidate,
  concepts: AnimeConcepts,
  originalDescription: string
): number {
  let score = 0;

  const candidateText = [
    candidate.mainTitle,
    candidate.description ?? "",
    candidate.genres.join(" "),
    candidate.synonyms.join(" "),
  ].join(" ").toLowerCase();

  // Pontuação por keywords EN no texto do candidato (peso alto)
  let kwMatches = 0;
  for (const kw of concepts.englishKeywords) {
    if (candidateText.includes(kw.toLowerCase())) kwMatches++;
  }
  const kwScore =
    concepts.englishKeywords.length > 0
      ? (kwMatches / concepts.englishKeywords.length) * 50
      : 0;
  score += kwScore;

  // Gêneros em comum
  const genreMatches = candidate.genres.filter((g) =>
    concepts.genres.includes(g)
  ).length;
  const genreScore =
    concepts.genres.length > 0 ? (genreMatches / concepts.genres.length) * 20 : 0;
  score += genreScore;

  // Palavras da descrição original no título/sinopse
  const ptWords = originalDescription
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);
  const ptMatches = ptWords.filter((w) => candidateText.includes(w)).length;
  const ptScore = ptWords.length > 0 ? (ptMatches / ptWords.length) * 15 : 0;
  score += ptScore;

  // Bonus por fonte (AniList é mais completo)
  const sourceBonus: Record<string, number> = {
    "anilist-anime": 10,
    jikan: 5,
    kitsu: 3,
  };
  score += sourceBonus[candidate.source] ?? 0;

  // Bonus por nota alta (0–5)
  if (candidate.score) score += Math.min((candidate.score / 100) * 5, 5);

  return Math.min(100, Math.round(score));
}
