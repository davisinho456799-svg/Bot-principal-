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
    .set({
      lastChapters: check.currentChapters,
      weeklyStartChapters: check.currentChapters,
      weeklyStartAt: new Date(),
      lastChecked: sql`now()`,
    })
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
      details: isFetchError(rawPrimary) ? rawPrimary.details : undefined,
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
          details: isFetchError(rawFetched) ? rawFetched.details : undefined,
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
      details: isFetchError(raw) ? raw.details : undefined,
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
      details: isFetchError(raw) ? raw.details : undefined,
    };
  })();

  const settled = await Promise.allSettled([comickTask, ...parallelTasks]);

  const successful: Array<{ source: string; fetched: FetchResult }> = [];

  for (const result of settled) {
    if (result.status === "rejected") {
      // Exceção inesperada na tarefa — não bloqueia as outras fontes
      continue;
    }
    const { source, fetched, errorKind, httpStatus, details } = result.value;
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
      details,
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
    logger.warn(
      {
        title,
        primarySource,
        attemptedSource: attempt.source,
        errorKind: kind,
        ...(attempt.httpStatus ? { httpStatus: attempt.httpStatus } : {}),
      },
      "Falha ao consultar fonte de notificação — tentando fallback",
    );
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
  discordGuildId?: string | null,
): Promise<boolean> {
  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) {
      throw new Error("Canal de notificação não é enviável");
    }

    const identity = getWorkIdentity(source);
    const PREFIX = `${identity.icon} Novo ${identity.unit}: `;

    const safeTitle = title.slice(0, 256 - PREFIX.length);

    // Quando isProxy (ex: updatedAt do AniList), não temos contagem real
    let descBody: string;
    if (isProxy) {
      descBody =
        `✨ O radar encontrou uma nova atualização para esta obra.\n\n` +
        `🔎 **Encontrar onde ler:**\n${buildScanLinksExternal(title)}`;
    } else {
      const newCount = Math.floor(newChapters);
      const oldCount = oldChapters != null ? Math.floor(oldChapters) : 0;
      const diff = newCount - oldCount;
      const pad = (n: number) => String(n).padStart(3, "0");
      const progressao = oldCount > 0
        ? `**${pad(oldCount)} → ${pad(newCount)}**`
        : `**${pad(newCount)}**`;
      descBody =
        `📖 **${identity.unit[0]?.toUpperCase()}${identity.unit.slice(1)} ${progressao}**` +
        (diff > 1 ? `\n✨ **+${diff} novos**` : "") +
        `\n\n🔎 **Encontrar onde ler:**\n${buildScanLinksExternal(title)}`;
    }

    const embed = createPanelWatchEmbed(identity.color)
      .setTitle(`${PREFIX}${safeTitle}`)
      .setURL(siteUrl || null)
      .setDescription(descBody.slice(0, 4096))
      .addFields(
        { name: "Tipo", value: `${identity.icon} ${identity.label}`, inline: true },
        { name: "Origem", value: "Radar automático", inline: true },
      );
    setPanelWatchFooter(embed, "Novo lançamento • Atualização automática");

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
    logNotificationError("NOTIFICATION_SEND_FAILED", "Erro ao enviar notificação", err, {
      channelId,
      title,
      discordGuildId,
      source,
      subscriberCount: mentions.length,
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
  discordGuildId?: string | null,
): Promise<boolean> {
  const metadataFields = changedFields.filter((field) => field !== "chapters");
  if (!metadataFields.length) return false;

  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) {
      throw new Error("Canal de alteração não é enviável");
    }

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

    const embed = createPanelWatchEmbed(PANEL_WATCH_COLORS.status)
      .setTitle(`📝 Atualização de catálogo • ${title}`.slice(0, 256))
      .setURL(siteUrl || null)
      .setDescription("O radar detectou uma mudança nos dados desta obra.")
      .addFields(fields)
    setPanelWatchFooter(embed, "Alteração de catálogo");

    if (coverUrl) embed.setThumbnail(coverUrl);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    logNotificationError(
      "METADATA_NOTIFICATION_SEND_FAILED",
      "Erro ao enviar notificação de alteração",
      err,
      { channelId, title, discordGuildId, changedFields: metadataFields },
    );
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
  source?: string,
  discordGuildId?: string | null,
): Promise<boolean> {
  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) {
      throw new Error("Canal de status não é enviável");
    }

    const hourBrasilia = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    ).getHours();
    const isSilent = hourBrasilia >= 22 || hourBrasilia < 7;

    const identity = getWorkIdentity(source);
    const embed =
      kind === "hiatus"
        ? createPanelWatchEmbed(PANEL_WATCH_COLORS.warning)
            .setTitle(`⏸️ ${title} entrou em hiato`.slice(0, 256))
            .setURL(siteUrl || null)
            .setDescription(
              `${identity.icon} Esta obra entrou em **hiato**.\n` +
              "O radar volta a avisar quando a publicação retomar."
            )
        : createPanelWatchEmbed(PANEL_WATCH_COLORS.success)
            .setTitle(`▶️ ${title} voltou a publicar`.slice(0, 256))
            .setURL(siteUrl || null)
            .setDescription(
              `${identity.icon} Esta obra **voltou do hiato**!\n` +
              "O radar retomará os avisos de novos lançamentos."
            )
    setPanelWatchFooter(embed, `Status da obra • ${identity.label}`);

    if (coverUrl) embed.setThumbnail(coverUrl);

    const content =
      mentions.length > 0 && !isSilent ? mentions.join(" ").slice(0, 2000) : undefined;

    await channel.send({ content, embeds: [embed] });
    return true;
  } catch (err) {
    logNotificationError(
      "STATUS_NOTIFICATION_SEND_FAILED",
      "Erro ao enviar notificação de status",
      err,
      { channelId, title, discordGuildId, kind, subscriberCount: mentions.length },
    );
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
  discordGuildId?: string | null,
): Promise<boolean> {
  try {
    const channel = getSendableChannel(
      await client.channels.fetch(channelId),
      channelId,
    );
    if (!channel) {
      throw new Error("Canal de obra finalizada não é enviável");
    }

    const hourBrasilia = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    ).getHours();
    const isSilent = hourBrasilia >= 22 || hourBrasilia < 7;

    const identity = getWorkIdentity();
    const embed = createPanelWatchEmbed(PANEL_WATCH_COLORS.finished)
      .setTitle(`🏁 ${title} foi finalizada`.slice(0, 256))
      .setURL(siteUrl || null)
      .setDescription(
        `${identity.icon} Esta obra foi marcada como **finalizada**.\n` +
        "O radar não enviará novos avisos de publicação."
      )
    setPanelWatchFooter(embed, "Obra finalizada");

    if (coverUrl) embed.setThumbnail(coverUrl);

    const content =
      mentions.length > 0 && !isSilent ? mentions.join(" ").slice(0, 2000) : undefined;

    await channel.send({ content, embeds: [embed] });
    return true;
  } catch (err) {
    logNotificationError(
      "FINISHED_NOTIFICATION_SEND_FAILED",
      "Erro ao enviar notificação de obra finalizada",
      err,
      { channelId, title, discordGuildId, subscriberCount: mentions.length },
    );
    return false;
  }
}

export async function runCheck(
  client: Client,
  options: { verifyAllSources?: boolean } = {},
): Promise<NotificationCheckSummary> {
  const summary = await withNotificationLock(() => runCheckLocked(client, options));
  return summary ?? emptyNotificationCheckSummary();
}

async function runCheckLocked(
  client: Client,
  options: { verifyAllSources?: boolean } = {},
): Promise<NotificationCheckSummary> {
  logger.info("Verificando atualizações de capítulos...");

  const canaisRows = await db.select().from(notificacaoCanaisTable);
  // A tabela antiga permitia mais de um registro por servidor. Mesmo que o
  // schema atual declare guild_id como chave primária, uma base já existente
  // pode ainda conter essas linhas. Um servidor deve participar da rodada uma
  // única vez, senão o mesmo embed sai repetido no mesmo canal.
  const canais = Array.from(
    new Map(canaisRows.map((canal) => [canal.guildId, canal])).values(),
  );
  if (canais.length !== canaisRows.length) {
    logger.warn(
      { rows: canaisRows.length, uniqueGuilds: canais.length },
      "Registros duplicados de canal de notificação ignorados nesta rodada",
    );
  }
  const manhwas = await getTrackedManhwas();
  const summary: NotificationCheckSummary = {
    titlesChecked: manhwas.length,
    successfulSources: 0,
    sourcesWithoutData: 0,
    fallbackUsed: 0,
    notificationsSent: 0,
    attempts: [],
  };
  // Uma obra pode estar cadastrada com IDs de fontes diferentes. Durante uma
  // rodada, todos esses registros representam o mesmo evento no mesmo canal.
  // A chave só é adicionada depois de um envio bem-sucedido, para não perder
  // notificações quando o Discord estiver indisponível.
  const sentEvents = new Set<string>();
  if (!manhwas.length) return summary;

  for (const m of manhwas) {
    try {
      let prefetchedDiagnosis: Awaited<ReturnType<typeof fetchWithFallback>> | null = null;

      // O ciclo automático usa o fluxo consolidado abaixo. O caminho legado
      // do Jikan só permanece disponível para o diagnóstico administrativo,
      // quando todas as fontes são solicitadas explicitamente.
      if (m.source === "jikan" && options.verifyAllSources) {
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
                .leftJoin(
                  releasePreferencesTable,
                  eq(releasePreferencesTable.discordUserId, assinaturasTable.discordUserId),
                )
                .where(
                  and(
                    eq(assinaturasTable.manhwaId, m.manhwaId),
                    eq(assinaturasTable.guildId, canal.guildId),
                    sql`COALESCE(${releasePreferencesTable.notificationsEnabled}, true) = true`,
                    sql`COALESCE(${releasePreferencesTable.digestMode}, 'imediato') = 'imediato'`,
                    sql`(${assinaturasTable.adult} = false OR COALESCE(${releasePreferencesTable.adultEnabled}, true) = true)`,
                  ),
                );
              // Não envia embed para guilds sem assinantes deste título
              if (!subscribers.length) continue;
              const mentions = [...new Set(subscribers.map((s) => `<@${s.discordUserId}>`))];
              const eventKey = notificationEventKey(
                canal.channelId,
                m.title,
                snapshot.chapters,
              );
              if (sentEvents.has(eventKey)) {
                logger.info(
                  { title: m.title, chapter: snapshot.chapters, channelId: canal.channelId },
                  "Notificação duplicada da mesma obra ignorada na rodada",
                );
                atLeastOneSentMal = true;
                continue;
              }
              const claim = await claimNotificationEvent(
                canal.channelId,
                m.title,
                snapshot.chapters,
              );
              if (!claim.claimed) {
                logger.info(
                  { title: m.title, chapter: snapshot.chapters, channelId: canal.channelId },
                  "Evento de notificação já registrado — baseline avançado sem novo envio",
                );
                sentEvents.add(eventKey);
                atLeastOneSentMal = true;
                continue;
              }
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
                false,
                canal.guildId,
              );
              if (sent) {
                sentEvents.add(eventKey);
                await markNotificationEventSent(eventKey).catch((err) => {
                  logger.error(
                    { err, eventKey },
                    "Mensagem enviada, mas não foi possível marcar o evento como concluído",
                  );
                });
                summary.notificationsSent++;
                atLeastOneSentMal = true;
              } else {
                await releaseNotificationEvent(eventKey).catch((err) => {
                  logger.warn(
                    { err, eventKey },
                    "Falha ao liberar evento de notificação após erro no Discord",
                  );
                });
              }
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
                canal.guildId,
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
                .leftJoin(
                  releasePreferencesTable,
                  eq(releasePreferencesTable.discordUserId, assinaturasTable.discordUserId),
                )
                .where(and(
                  eq(assinaturasTable.manhwaId, m.manhwaId),
                  eq(assinaturasTable.guildId, canal.guildId),
                  sql`COALESCE(${releasePreferencesTable.notificationsEnabled}, true) = true`,
                  sql`COALESCE(${releasePreferencesTable.digestMode}, 'imediato') = 'imediato'`,
                  sql`(${assinaturasTable.adult} = false OR COALESCE(${releasePreferencesTable.adultEnabled}, true) = true)`,
                ));
              if (!subscribers.length) continue;
              const mentions = [...new Set(subscribers.map((s) => `<@${s.discordUserId}>`))];
              const sent = await sendStatusChangeNotification(
                client, canal.channelId, m.title, m.siteUrl, m.coverUrl ?? null, mentions, kind,
                m.source, canal.guildId,
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
                .leftJoin(
                  releasePreferencesTable,
                  eq(releasePreferencesTable.discordUserId, assinaturasTable.discordUserId),
                )
                .where(
                  and(
                    eq(assinaturasTable.manhwaId, m.manhwaId),
                    eq(assinaturasTable.guildId, canal.guildId),
                    sql`COALESCE(${releasePreferencesTable.notificationsEnabled}, true) = true`,
                    sql`COALESCE(${releasePreferencesTable.digestMode}, 'imediato') = 'imediato'`,
                    sql`(${assinaturasTable.adult} = false OR COALESCE(${releasePreferencesTable.adultEnabled}, true) = true)`,
                  ),
                );
              if (!subscribers.length) continue;
              const mentions = [...new Set(subscribers.map((s) => `<@${s.discordUserId}>`))];
              const sent = await sendFinishedNotification(
                client,
                canal.channelId,
                m.title,
                m.siteUrl,
                m.coverUrl ?? null,
                mentions,
                canal.guildId,
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
          weeklyStartChapters: newChapters,
          weeklyStartAt: new Date(),
        });
        continue;
      }

      // Registros criados antes do snapshot semanal começam a contar a partir
      // do primeiro ciclo em que forem vistos após a migração.
      if (existing.weeklyStartAt == null) {
        await db
          .update(capitulosRastreados)
          .set({
            weeklyStartChapters: existing.lastChapters,
            weeklyStartAt: new Date(),
          })
          .where(eq(capitulosRastreados.manhwaId, m.manhwaId));
        existing.weeklyStartChapters = existing.lastChapters;
        existing.weeklyStartAt = new Date();
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
          .set({
            lastChapters: newChapters,
            weeklyStartChapters: newChapters,
            weeklyStartAt: new Date(),
            lastChecked: sql`now()`,
          })
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
              .leftJoin(
                releasePreferencesTable,
                eq(releasePreferencesTable.discordUserId, assinaturasTable.discordUserId),
              )
              .where(
                and(
                  eq(assinaturasTable.manhwaId, m.manhwaId),
                  eq(assinaturasTable.guildId, canal.guildId),
                  sql`COALESCE(${releasePreferencesTable.notificationsEnabled}, true) = true`,
                  sql`COALESCE(${releasePreferencesTable.digestMode}, 'imediato') = 'imediato'`,
                  sql`(${assinaturasTable.adult} = false OR COALESCE(${releasePreferencesTable.adultEnabled}, true) = true)`,
                ),
              );
            // Não envia embed para guilds sem assinantes deste título
            if (!subscribers.length) continue;
            const mentions = [...new Set(subscribers.map((s) => `<@${s.discordUserId}>`))];
            const eventKey = notificationEventKey(canal.channelId, m.title, newChapters);
            if (sentEvents.has(eventKey)) {
              logger.info(
                { title: m.title, chapter: newChapters, channelId: canal.channelId },
                "Notificação duplicada da mesma obra ignorada na rodada",
              );
              // Este registro aponta para o mesmo evento já enviado por outro
              // ID da fonte. Avança sua linha de base para não repetir no
              // próximo ciclo de duas horas.
              atLeastOneSent = true;
              continue;
            }
            const claim = await claimNotificationEvent(canal.channelId, m.title, newChapters);
            if (!claim.claimed) {
              logger.info(
                { title: m.title, chapter: newChapters, channelId: canal.channelId },
                "Evento de notificação já registrado — baseline avançado sem novo envio",
              );
              sentEvents.add(eventKey);
              atLeastOneSent = true;
              continue;
            }
            const sent = await sendNotification(
              client,
              canal.channelId,
              m.title,
              newChapters,
              lastChapters,
              m.siteUrl,
              m.coverUrl ?? null,
              mentions,
              diagnosis.selectedSource ?? m.source,
              isProxy,
              canal.guildId,
            );
            if (sent) {
              sentEvents.add(eventKey);
              await markNotificationEventSent(eventKey).catch((err) => {
                logger.error(
                  { err, eventKey },
                  "Mensagem enviada, mas não foi possível marcar o evento como concluído",
                );
              });
              atLeastOneSent = true;
              summary.notificationsSent++;
            } else {
              await releaseNotificationEvent(eventKey).catch((err) => {
                logger.warn(
                  { err, eventKey },
                  "Falha ao liberar evento de notificação após erro no Discord",
                );
              });
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
          weeklyStartChapters: capitulosRastreados.weeklyStartChapters,
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

      const events = await db
        .select({
          title: notificacaoEventosTable.title,
          chapter: notificacaoEventosTable.chapter,
        })
        .from(notificacaoEventosTable)
        .where(
          and(
            eq(notificacaoEventosTable.channelId, canal.channelId),
            isNotNull(notificacaoEventosTable.sentAt),
            gte(notificacaoEventosTable.sentAt, since),
          ),
        );

      const chaptersByTitle = new Map<string, number[]>();
      for (const event of events) {
        const chapters = chaptersByTitle.get(event.title) ?? [];
        chapters.push(event.chapter);
        chaptersByTitle.set(event.title, chapters);
      }

      if (!rows.length) continue;

      const formatChapter = (chapter: number | null): string => {
        if (chapter == null || !Number.isFinite(chapter)) return "—";
        const value = String(chapter);
        const [integerPart, decimalPart] = value.split(".");
        return `${integerPart.padStart(3, "0")}${decimalPart ? `.${decimalPart}` : ""}`;
      };

      const lines = rows.map((r) => {
        const chapters = chaptersByTitle.get(r.title) ?? [];
        const start = r.weeklyStartChapters;
        const end = r.lastChapters;
        const progression =
          start != null && end != null
            ? `${formatChapter(start)} → ${formatChapter(end)}`
            : `— → ${formatChapter(end)}`;
        const releases = chapters.length
          ? ` · ${chapters.length} lançamento${chapters.length === 1 ? "" : "s"}`
          : "";
        const title = r.siteUrl ? `[${r.title}](${r.siteUrl})` : r.title;
        return `• ${title} · Cap. **${progression}**${releases}`;
      });
      const description = (
        `📚 **${rows.length}** obra${rows.length === 1 ? "" : "s"} acompanhada${rows.length === 1 ? "" : "s"}\n` +
        `🆕 **${events.length}** capítulo${events.length === 1 ? "" : "s"} lançado${events.length === 1 ? "" : "s"}\n\n` +
        lines.join("\n")
      ).slice(0, 4096);

      const channel = getSendableChannel(
        await client.channels.fetch(canal.channelId),
        canal.channelId,
      );
      if (!channel) continue;

      const embed = createPanelWatchEmbed(PANEL_WATCH_COLORS.primary)
        .setTitle("🗓️ Resumo semanal · Radar de leitura")
        .setDescription(description)
      setPanelWatchFooter(embed, "Resumo semanal • Início → fim da semana");

      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      logger.error({ err, guildId: canal.guildId }, "Erro ao enviar resumo semanal");
    }
  }

  // O próximo resumo deve começar no capítulo atual, não acumular o período
  // anterior. A atualização é feita depois do envio para preservar os dados
  // usados nesta edição.
  await db
    .update(capitulosRastreados)
    .set({
      weeklyStartChapters: sql`${capitulosRastreados.lastChapters}`,
      weeklyStartAt: new Date(),
    });

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
  if (notificacaoServiceStarted) {
    logger.warn("Serviço de notificações já foi iniciado — ignorando nova inicialização");
    return;
  }
  notificacaoServiceStarted = true;

  const runSafe = async () => {
    if (verificationInProgress) {
      logger.warn("Verificação anterior ainda está em andamento — pulando esta rodada");
      return;
    }
    verificationInProgress = true;
    try {
      const summary = await runCheck(client, { verifyAllSources: true });
      logger.info(
        {
          titlesChecked: summary.titlesChecked,
          successfulSources: summary.successfulSources,
          sourcesWithoutData: summary.sourcesWithoutData,
          fallbackUsed: summary.fallbackUsed,
          notificationsSent: summary.notificationsSent,
        },
        "Verificação automática concluída",
      );
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
