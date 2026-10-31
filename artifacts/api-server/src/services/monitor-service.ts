import { and, eq, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Client } from "discord.js";
import type sharp from "sharp";
import { db } from "@workspace/db";
import {
  detectedChaptersTable,
  monitorActivityTable,
  monitorHistoryTable,
  monitorConfigTable,
  monitoredWorksTable,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { loadMonitorDependency } from "../lib/monitor-dependencies";
import { measureImageMonitorRound, type ImageMonitorTiming } from "./monitor-timing";
import { monitorExecution } from "./monitor-execution.js";
import { assertMonitorPlatformEnabled, isMonitorPlatformEnabled } from "./monitor-platform-settings.js";
import { translateChapterSubtitles } from "./chapter-subtitle-translation";
import { recordBotError } from "../bot/error-log.js";
import { buildSubtitleFallbackRow, buildSubtitleRowsLayout } from "./chapter-subtitle-render";
import { renderToptoonPairCard } from "./toptoon-pair-render";
import { selectPairTestImage, type TestImageSelection } from "./monitor-test-fallback";
import { fetchThumbnailBytes } from "./monitor-thumbnail-download";
import { RELEASE_BANNER_HEIGHT, buildReleaseBannerMarkup, buildReleaseBannerSvg, type ReleaseBannerTheme } from "./release-banner";
import {
  buildChapterKey,
  genericParser,
  parserForPlatform,
  type MonitorPlatform,
  type ParsedChapter,
  type ParserContext,
} from "./parsers/index";
import {
  capturedGroupWithinLimit,
  openBrowserListing,
  type BrowserChapter,
  type BrowserListingSession,
  type CapturedChapterGroup,
} from "./browser-chapter-capture";
import {
  chapterNumberIdentity,
  highestTrustedChapterNumber,
  isAbsurdChapterOutlier,
  numericChapterNumber,
} from "./monitor-chapter-guard";
import {
  formatMonitorLinkWarning,
  getMonitorLinkRedirect,
  monitorLinkWarningKey,
} from "./monitor-link-warning.js";

type ChapterCandidate = ParsedChapter & {
  key: string;
  parser: string;
  captureId?: string;
};

function captureSubtitles(chapters: ChapterCandidate[], platform: MonitorPlatform) {
  return chapters.filter(chapter =>
    chapter.captureId && (platform === "toomics" || chapter.subtitle)
  ).map(chapter => ({
    captureId: chapter.captureId!,
    chapterNumber: platform === "toomics" ? chapter.number : undefined,
    subtitleEn: chapter.subtitleEn,
    subtitleKo: chapter.subtitleKo,
    subtitlePt: chapter.subtitlePt,
  }));
}

type ExistingChapter = {
  id: number;
  key: string;
  number: string;
  thumbnailUrl: string;
  publishedAt: Date | null;
  deliveryPending: boolean;
};

type MonitorImageMode = "browser+banner" | "sharp+banner" | "primary+banner" | "none";

const HISTORICAL_RELEASE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const MONITOR_LINK_DELTA_PENDING_STATUS = "Link atualizado — diferença de capítulos pendente";
const MONITOR_LINK_DELTA_PREVIOUS_URL_MARKER = "|previous=";

export function buildMonitorLinkDeltaPendingStatus(previousUrl?: string) {
  return previousUrl
    ? `${MONITOR_LINK_DELTA_PENDING_STATUS}${MONITOR_LINK_DELTA_PREVIOUS_URL_MARKER}${encodeURIComponent(previousUrl)}`
    : MONITOR_LINK_DELTA_PENDING_STATUS;
}

function hasPendingLinkDelta(status: string | null | undefined) {
  return status?.startsWith(MONITOR_LINK_DELTA_PENDING_STATUS) ?? false;
}

function getPendingLinkDeltaPreviousUrl(status: string | null | undefined) {
  const markerIndex = status?.indexOf(MONITOR_LINK_DELTA_PREVIOUS_URL_MARKER) ?? -1;
  if (markerIndex < 0 || !status) return null;
  try {
    const url = decodeURIComponent(
      status.slice(markerIndex + MONITOR_LINK_DELTA_PREVIOUS_URL_MARKER.length),
    );
    return new URL(url).toString();
  } catch {
    return null;
  }
}

type SharpFactory = typeof sharp;

let sharpFactoryPromise: Promise<SharpFactory> | null = null;
let sharpWarningLogged = false;

async function getSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ??= loadMonitorDependency("sharp")
    .then((module) => (module as typeof import("sharp")).default)
    .catch(error => { sharpFactoryPromise = null; throw error; });
  return sharpFactoryPromise;
}

async function getOptionalSharp(): Promise<SharpFactory | null> {
  try {
    return await getSharp();
  } catch (error) {
    if (!sharpWarningLogged) {
      sharpWarningLogged = true;
      logger.warn(
        { err: error },
        "Sharp não está disponível; o monitor continuará sem gerar imagens de fallback",
      );
    }
    return null;
  }
}

function isHistoricalRelease(
  chapter: ChapterCandidate,
  checkedAt: Date,
): boolean {
  if (!chapter.releaseDate) return false;
  const releaseTime = Date.parse(`${chapter.releaseDate}T12:00:00Z`);
  return Number.isFinite(releaseTime) &&
    checkedAt.getTime() - releaseTime > HISTORICAL_RELEASE_MAX_AGE_MS;
}

function isReleasedBeforePreviousCheck(
  chapter: ChapterCandidate,
  previousCheckAt: Date | null,
): boolean {
  if (!chapter.releaseDate || !previousCheckAt) return false;

  // Os sites normalmente informam apenas a data, não o horário. Comparar
  // pelo início do dia evita que um capítulo publicado no mesmo dia da
  // verificação seja descartado por causa do horário da rodada anterior.
  const previousCheckDate = previousCheckAt.toISOString().slice(0, 10);
  return chapter.releaseDate < previousCheckDate;
}

function isReleasedBeforeMonitorCreation(
  chapter: ChapterCandidate,
  createdAt: Date,
): boolean {
  if (!chapter.releaseDate) return false;
  return chapter.releaseDate < createdAt.toISOString().slice(0, 10);
}

async function migrateLegacyKeys(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  work: typeof monitoredWorksTable.$inferSelect,
  existing: ExistingChapter[],
) {
  const occupiedKeys = new Set(existing.map((chapter) => chapter.key));
  for (const chapter of existing) {
    const desiredKey = buildChapterKey(
      work.platform as MonitorPlatform,
      work.title,
      chapter.number,
    );
    if (chapter.key === desiredKey || occupiedKeys.has(desiredKey)) continue;
    await tx
      .update(detectedChaptersTable)
      .set({ chapterKey: desiredKey })
      .where(and(
        eq(detectedChaptersTable.id, chapter.id),
        eq(detectedChaptersTable.workId, work.id),
      ));
    occupiedKeys.add(desiredKey);
  }
}

function withChapterKeys(
  chapters: ParsedChapter[],
  platform: MonitorPlatform,
  workTitle: string,
  parser: string,
): ChapterCandidate[] {
  const seen = new Set<string>();
  return chapters
    .map((chapter) => ({
      ...chapter,
      key: buildChapterKey(platform, workTitle, chapter.number),
      parser,
    }))
    .filter((chapter) => {
      if (seen.has(chapter.key)) return false;
      seen.add(chapter.key);
      return true;
    });
}

type ListingSession = {
  parser: string;
  candidates: ChapterCandidate[];
  finalUrl?: string;
  captureSession?: BrowserListingSession;
};

export type MonitorProgressReporter = (message: string) => Promise<void> | void;

async function reportProgress(
  progress: MonitorProgressReporter | undefined,
  message: string,
): Promise<void> {
  try {
    await progress?.(message);
  } catch (error) {
    logger.debug({ err: error }, "Não foi possível atualizar o progresso do monitor");
  }
}

async function fetchListing(
  work: typeof monitoredWorksTable.$inferSelect,
  progress?: MonitorProgressReporter,
): Promise<ListingSession> {
  const platform = work.platform as MonitorPlatform;
  assertMonitorPlatformEnabled(platform);
  const context: ParserContext = {
    listingUrl: work.listingUrl,
    platform,
    workTitle: work.title,
  };

  let browserFinalUrl: string | undefined;
  try {
    await reportProgress(progress, "Abrindo a página com o navegador e procurando os cards de capítulos.");
    const browserListing = await openBrowserListing(work.listingUrl, platform);
    browserFinalUrl = browserListing.diagnostics?.finalUrl;
    if (browserListing.candidates.length) {
      const browserCandidates = browserListing.candidates as BrowserChapter[];
      await reportProgress(
        progress,
        `O navegador encontrou ${browserCandidates.length} capítulo(s) renderizado(s).`,
      );
      return {
        parser: "Playwright browser",
        candidates: withChapterKeys(
          browserCandidates,
          platform,
          work.title,
          "Playwright browser",
        ),
        finalUrl: browserFinalUrl,
        captureSession: browserListing,
      };
    }
    await browserListing.close();
    logger.debug(
      { workId: work.id, diagnostics: browserListing.diagnostics },
      "Playwright encontrou a página, mas não encontrou capítulos",
    );
    const diagnostics = browserListing.diagnostics;
    const signals = diagnostics.signals.length
      ? ` Sinais detectados: ${diagnostics.signals.join(", ")}.`
      : "";
    const authentication = diagnostics.authentication !== "não aplicável"
      ? ` Autenticação: ${diagnostics.authentication}.`
      : "";
    await reportProgress(
      progress,
      `O navegador não encontrou cards; URL final: ${diagnostics.finalUrl}; título: "${diagnostics.pageTitle || "sem título"}"; texto: ${diagnostics.bodyTextLength} caracteres; imagens visíveis: ${diagnostics.visibleImageCount}.${authentication}${signals}`,
    );
    await reportProgress(progress, "Tentando o parser da plataforma.");
  } catch (error) {
    logger.warn(
      { err: error, workId: work.id, platform },
      "Playwright falhou; usando parser HTML como fallback",
    );
    const reason = error instanceof Error
      ? ` (${error.message.split("\n")[0].slice(0, 160)})`
      : "";
    await reportProgress(progress, `A captura do navegador falhou${reason}; tentando o parser da plataforma.`);
  }

  const specificParser = parserForPlatform(work.platform);

  if (specificParser) {
    try {
      await reportProgress(progress, `Lendo a página com ${specificParser.name}.`);
      const specificChapters = await specificParser.parse(context);
      if (specificChapters.length) {
        await reportProgress(
          progress,
          `${specificParser.name} encontrou ${specificChapters.length} capítulo(s).`,
        );
        return {
          parser: specificParser.name,
          candidates: withChapterKeys(specificChapters, platform, work.title, specificParser.name),
        };
      }
      logger.debug({ workId: work.id, parser: specificParser.name }, "Specific parser found no chapters; using generic parser");
      await reportProgress(progress, "O parser específico não encontrou capítulos; tentando o parser genérico.");
    } catch (error) {
      logger.warn({ err: error, workId: work.id, parser: specificParser.name }, "Specific parser failed; using generic parser");
      await reportProgress(progress, "O parser específico falhou; tentando o parser genérico.");
    }
  }

  await reportProgress(progress, "Lendo a página com o parser genérico.");
  const genericChapters = await genericParser.parse(context);
  await reportProgress(progress, `Parser genérico encontrou ${genericChapters.length} capítulo(s).`);
  return {
    parser: specificParser ? `${genericParser.name} (fallback)` : genericParser.name,
    candidates: withChapterKeys(genericChapters, platform, work.title, genericParser.name),
    finalUrl: browserFinalUrl,
  };
}

const TOOMICS_LOGO_PLACEHOLDER_SHA256 = "6e60bf68bbb9fa0eba2b72aa5cd659b4e88f182b32799e2b363cf1a1f560874b";
const TOOMICS_LOGO_PLACEHOLDER_AVERAGE_HASH =
  "0000000000000000000000000011110000111100000000000000000000000000";
const TOOMICS_LOGO_HASH_MAX_DISTANCE = 2;
const TOOMICS_LOGO_ASPECT_RATIO = 438 / 342;

function isToomicsThumbnailUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "toomics.com" || hostname.endsWith(".toomics.com");
  } catch {
    return false;
  }
}

async function isToomicsLogoPlaceholder(
  url: string,
  bytes: Buffer,
  sharp: SharpFactory,
): Promise<boolean> {
  if (!isToomicsThumbnailUrl(url)) return false;
  if (createHash("sha256").update(bytes).digest("hex") === TOOMICS_LOGO_PLACEHOLDER_SHA256) {
    return true;
  }

  const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
  if (!metadata.width || !metadata.height) return false;
  const aspectRatio = metadata.width / metadata.height;
  if (Math.abs(aspectRatio - TOOMICS_LOGO_ASPECT_RATIO) > 0.08) return false;

  const { data } = await sharp(bytes, { limitInputPixels: 24_000_000 })
    .resize(8, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length !== TOOMICS_LOGO_PLACEHOLDER_AVERAGE_HASH.length) return false;
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  const averageHash = Array.from(data, value => value >= average ? "1" : "0").join("");
  const distance = Array.from(averageHash, (bit, index) =>
    bit === TOOMICS_LOGO_PLACEHOLDER_AVERAGE_HASH[index] ? 0 : 1,
  ).reduce((sum, difference) => sum + difference, 0);
  return distance <= TOOMICS_LOGO_HASH_MAX_DISTANCE;
}

async function isToomicsLogoPlaceholderUrl(url: string): Promise<boolean> {
  if (!isToomicsThumbnailUrl(url)) return false;
  try {
    const sharp = await getOptionalSharp();
    if (!sharp) return false;
    const bytes = await fetchThumbnailBytes(url, { timeoutMs: 3_000, maxBytes: 2 * 1024 * 1024 });
    return Boolean(bytes && await isToomicsLogoPlaceholder(url, bytes, sharp));
  } catch {
    return false;
  }
}

async function downloadThumbnail(url: string, timeoutMs?: number): Promise<Buffer | null> {
  try {
    if (/fullversion|full[-_ ]?version|download[-_ ]?app|app[-_ ]?version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)|(?:^|[/._-])(?:banner|bnr|lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i.test(url)) {
      return null;
    }
    const sharp = await getOptionalSharp();
    if (!sharp) return null;
    const bytes = await fetchThumbnailBytes(url, { timeoutMs });
    if (!bytes) return null;
    if (await isToomicsLogoPlaceholder(url, bytes, sharp)) {
      logger.warn({ host: new URL(url).hostname }, "Miniatura do Toomics rejeitada: imagem contém apenas o logo");
      return null;
    }
    const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
    if (!metadata.width || !metadata.height) return null;
    if (metadata.width / metadata.height > 4.2) return null;
    const stats = await sharp(bytes, { limitInputPixels: 24_000_000 }).stats();
    const colorChannels = stats.channels.slice(0, 3);
    const alpha = stats.channels[3];
    const isFullyTransparent = Boolean(alpha && alpha.max < 8);
    const isNearlyBlank = colorChannels.length > 0 &&
      colorChannels.every((channel) =>
        channel.mean > 248 && channel.stdev < 4 && channel.max - channel.min < 12,
      );
    if (isFullyTransparent || isNearlyBlank) return null;
    return bytes;
  } catch {
    return null;
  }
}

async function buildStrip(
  title: string,
  chapters: ChapterCandidate[],
  requireThumbnail = false,
  includeBanner = true,
  rejectedThumbnailUrls: ReadonlySet<string> = new Set(),
): Promise<Buffer | null> {
  const sharp = await getOptionalSharp();
  if (!sharp) return null;
  const rowHeight = 164;
  const width = 920;
  const headerHeight = includeBanner ? RELEASE_BANNER_HEIGHT : 0;
  const layout = buildSubtitleRowsLayout(chapters, headerHeight, rowHeight);
  const height = layout.height;
  const images = await Promise.all(chapters.map(async (chapter) => ({
    chapter,
    data: rejectedThumbnailUrls.has(chapter.thumbnailUrl)
      ? null
      : await downloadThumbnail(chapter.thumbnailUrl, requireThumbnail ? 10_000 : undefined),
  })));
  if (images.every(image => !image.data)) {
    if (requireThumbnail) {
      logger.warn(
        {
          title,
          chapters: images.map(({ chapter }) => ({
            number: chapter.number,
            hasThumbnailUrl: Boolean(chapter.thumbnailUrl?.trim()),
          })),
        },
        "Miniatura principal ausente ou não utilizável; fallback de imagem não gerado",
      );
    }
    return null;
  }
  const imageRows = images.map(({ chapter, data }, index) => {
    const y = layout.rows[index].y;
    return buildSubtitleFallbackRow(chapter, y, layout.rows[index].height, Boolean(data));
  }).join("");
  const chapterNumbers = chapters.map(chapter => chapter.number);
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#202122"/>${includeBanner ? buildReleaseBannerMarkup(title, chapterNumbers, "dark") : ""}${imageRows}</svg>`;
  let output = await sharp(Buffer.from(baseSvg)).png().toBuffer();
  const composites = await Promise.all(images.map(async ({ data, chapter }, index) => {
    if (!data) return null;
    const thumbnail = await sharp(data)
      .resize(240, 140, {
        fit: "contain",
        background: { r: 32, g: 33, b: 34, alpha: 1 },
      })
      .png()
      .toBuffer();
    return {
      input: thumbnail,
      left: 24,
      top: layout.rows[index].y,
    };
  }));
  const validComposites = composites.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (validComposites.length) {
    output = await sharp(output)
      .composite(validComposites)
      .png()
      .toBuffer();
  }
  return output;
}

class PairTestImageError extends Error {}

async function buildPairTestStrip(title: string, chapters: ChapterCandidate[]): Promise<Buffer | null> {
  if (chapters.length !== 1) throw new PairTestImageError("O teste deve selecionar um único capítulo.");
  const card = await buildPairCard(chapters[0]);
  return addReleaseBanner(card, title, [chapters[0].number], "dark");
}

async function buildPairCard(chapter: ChapterCandidate): Promise<Buffer> {
  if (!chapter.extraThumbnailUrls) {
    throw new PairTestImageError("O capítulo não tem duas miniaturas extras disponíveis.");
  }
  if (!await getOptionalSharp()) throw new PairTestImageError("O gerador de imagens (Sharp) não está disponível no worker.");
  const images = await Promise.all(chapter.extraThumbnailUrls.map(url => downloadThumbnail(url, 10_000)));
  if (!images[0] || !images[1]) {
    const missing = images.flatMap((image, index) => image ? [] : [index + 2]);
    throw new PairTestImageError(`Não consegui carregar a miniatura extra ${missing.join(" e ")}.`);
  }
  return renderToptoonPairCard(chapter, [images[0], images[1]]);
}

/** Preserve notification batches, with independent fallback for each chapter. */
export async function buildAutomaticToptoonStrip(title: string, chapters: ChapterCandidate[]) {
  const primaryChapters: string[] = [];
  const textChapters: string[] = [];
  const sharp = await getOptionalSharp();
  if (!sharp) return { image: null, primaryChapters, textChapters: chapters.map(chapter => chapter.number) };
  const rows: Array<{ input: Buffer; height: number }> = [];
  for (const chapter of chapters) {
    const selected = await selectPairTestImage({
      renderPair: () => buildPairCard(chapter),
      renderPrimary: () => buildStrip(title, [chapter], true, false),
      onFailure: (stage, error) => logger.warn({ err: error, title, chapter: chapter.number, stage }, "Imagem automática indisponível; tentando reserva do mesmo capítulo"),
    });
    if (selected.selection === "primary") primaryChapters.push(chapter.number);
    if (!selected.image) { textChapters.push(chapter.number); continue; }
    const input = await sharp(selected.image).resize({ width: 1024 }).png().toBuffer();
    const metadata = await sharp(input).metadata();
    rows.push({ input, height: metadata.height! });
  }
  if (!rows.length) return { image: null, primaryChapters, textChapters };
  let top = 0;
  const composite = rows.map(row => {
    const item = { input: row.input, left: 0, top };
    top += row.height;
    return item;
  });
  const strip = await sharp({ create: { width: 1024, height: top, channels: 4, background: "#202122" } })
    .composite(composite).png().toBuffer();
  const image = await addReleaseBanner(strip, title, chapters.map(chapter => chapter.number), "dark");
  if (!image) throw new PairTestImageError("Não foi possível decorar a montagem automática.");
  return { image, primaryChapters, textChapters };
}

export async function addReleaseBanner(
  image: Buffer,
  title: string,
  chapterNumbers: readonly string[],
  theme: ReleaseBannerTheme = "light",
): Promise<Buffer | null> {
  const sharp = await getOptionalSharp();
  if (!sharp) return null;

  try {
    const metadata = await sharp(image).metadata();
    if (!metadata.width || !metadata.height) return null;

    const banner = Buffer.from(
      buildReleaseBannerSvg(metadata.width, title, chapterNumbers, theme),
    );

    const decorated = await sharp(image)
      .extend({
        top: RELEASE_BANNER_HEIGHT,
        bottom: 0,
        left: 0,
        right: 0,
        background: theme === "dark" ? "#202122" : "#fffaf3",
      })
      .composite([{ input: banner, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const decoratedMetadata = await sharp(decorated).metadata();
    if (
      decoratedMetadata.width !== metadata.width ||
      decoratedMetadata.height !== metadata.height + RELEASE_BANNER_HEIGHT
    ) {
      logger.warn(
        {
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          decoratedWidth: decoratedMetadata.width,
          decoratedHeight: decoratedMetadata.height,
        },
        "A captura decorada não recebeu o banner completo; usando fallback",
      );
      return null;
    }
    return decorated;
  } catch (error) {
    logger.warn({ err: error }, "Não foi possível adicionar o banner à captura do navegador");
    return null;
  }
}

export async function postStrip(
  channelId: string,
  title: string,
  chapters: ChapterCandidate[],
  part: number,
  total: number,
  isTest = false,
  capturedImage?: Buffer,
  pairTest = false,
  progress?: MonitorProgressReporter,
  editMessageId?: string,
): Promise<MonitorImageMode> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  // Both paths must use the same release banner. Browser captures contain only
  // the real platform cards, while the Sharp path already renders its banner.
  // Never send a raw browser capture: that was the source of inconsistent
  // notifications where only some images showed "NEW CHAPTERS".
  let browserImage: Buffer | null = null;
  const rejectedToomicsThumbnailUrls = new Set<string>();
  if (capturedImage) {
    try {
      const toomicsThumbnailUrls = [...new Set(
        chapters.map(chapter => chapter.thumbnailUrl).filter(isToomicsThumbnailUrl),
      )];
      const placeholderMatches = await Promise.all(
        toomicsThumbnailUrls.map(async url => [url, await isToomicsLogoPlaceholderUrl(url)] as const),
      );
      for (const [url, isPlaceholder] of placeholderMatches) {
        if (isPlaceholder) rejectedToomicsThumbnailUrls.add(url);
      }
      const rejectedChapterNumbers = chapters
        .filter(chapter => rejectedToomicsThumbnailUrls.has(chapter.thumbnailUrl))
        .map(chapter => chapter.number);
      if (rejectedChapterNumbers.length) {
        logger.warn(
          { title, chapterNumbers: rejectedChapterNumbers },
          "Captura do navegador descartada: miniatura do Toomics contém apenas o logo",
        );
      } else {
        browserImage = await addReleaseBanner(capturedImage, title, chapters.map(chapter => chapter.number));
      }
    } catch (error) {
      logger.warn({ err: error, title }, "Falha ao adicionar banner à captura; tentando fallback");
    }
  }

  let png = browserImage;
  let primaryFallback = false;
  let automaticFallbackNote = "";
  if (pairTest && !isTest) {
    if (!png) {
      try {
        const selected = await buildAutomaticToptoonStrip(title, chapters);
        png = selected.image;
        automaticFallbackNote = [
          ...(selected.primaryChapters.length ? [`principal como reserva: capítulos ${selected.primaryChapters.join(", ")}`] : []),
          ...(selected.textChapters.length ? [`somente texto: capítulos ${selected.textChapters.join(", ")}`] : []),
        ].map(note => ` · ${note}`).join("");
      } catch (error) {
        logger.warn({ err: error, title }, "Montagem automática falhou; tentando imagens principais");
        try {
          png = await buildStrip(title, chapters, true);
          primaryFallback = Boolean(png);
        } catch (primaryError) {
          logger.warn({ err: primaryError, title }, "Reserva principal indisponível; preservando o aviso em texto");
          png = null;
        }
      }
    }
  } else if (pairTest) {
    const selected = await selectPairTestImage({
      captured: browserImage,
      renderPair: () => buildPairTestStrip(title, chapters),
      renderPrimary: () => buildStrip(title, chapters, true),
      report: message => reportProgress(progress, message),
      onFailure: (stage, error) => logger.warn({ err: error, title, stage }, "Falha na imagem do teste; tentando próxima reserva"),
    });
    png = selected.image;
    primaryFallback = selected.selection === "primary";
  } else if (!png) {
    try {
      png = await buildStrip(title, chapters, false, true, rejectedToomicsThumbnailUrls);
    } catch (error) {
      // Normal notifications may still deliver their textual release notice.
      logger.warn({ err: error, title }, "Falha ao gerar imagem do monitor; enviando aviso sem anexo");
      png = null;
    }
  }
  const imageMode: MonitorImageMode = primaryFallback
    ? "primary+banner"
    : browserImage
      ? "browser+banner"
      : png
        ? "sharp+banner"
        : "none";
  const form = new FormData();
  const chapterSummary = chapters.length === 1
    ? `1 capítulo novo · capítulo ${chapters[0].number}`
    : `${chapters.length} capítulos novos · capítulos ${chapters.map((chapter) => chapter.number).join(", ")}`;
  const messageContent = `${isTest ? "🧪 **TESTE** · " : ""}**${title}** · ${chapterSummary}${total > 1 ? ` · parte ${part}/${total}` : ""}`;
  if (!png) {
    logger.warn(
      { title, chapterNumbers: chapters.map((chapter) => chapter.number) },
      "Nenhuma imagem do monitor foi obtida; enviando notificação sem anexo",
    );
  }
  if (editMessageId && !png) {
    throw new Error("Não consegui gerar uma imagem; a mensagem atual foi mantida sem alterações.");
  }
  const filename = `chapter-release-${isTest ? "test-" : ""}${Date.now()}-${part}.png`;
  form.append("payload_json", JSON.stringify({
    content: `${messageContent}${automaticFallbackNote}${primaryFallback ? " · imagem principal usada como reserva" : ""}${png ? "" : pairTest ? " · aviso em texto: imagens indisponíveis" : " · imagem indisponível no modo leve"}`,
    ...(editMessageId ? {
      embeds: [],
      attachments: [{
        id: "0",
        filename,
        description: `${title} · ${chapterSummary}`,
      }],
    } : {}),
    allowed_mentions: { parse: [] },
  }));
  if (png) {
    const pngArrayBuffer = new ArrayBuffer(png.byteLength);
    new Uint8Array(pngArrayBuffer).set(png);
    const pngBlob = new Blob([pngArrayBuffer], { type: "image/png" });
    form.append("files[0]", pngBlob, filename);
  }
  const messageUrl = `https://discord.com/api/v10/channels/${channelId}/messages${editMessageId ? `/${editMessageId}` : ""}`;
  if (editMessageId) {
    if (!/^\d{17,20}$/.test(editMessageId)) throw new Error("O ID da mensagem Discord é inválido.");
    const existingResponse = await fetch(messageUrl, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!existingResponse.ok) throw new Error(`Não consegui validar a mensagem que será substituída (HTTP ${existingResponse.status}).`);
    const existing = await existingResponse.json();
    if (
      !existing.author?.bot ||
      existing.channel_id !== channelId ||
      existing.content !== messageContent
    ) {
      throw new Error("A mensagem não pertence ao bot ou não corresponde exatamente à obra e aos capítulos selecionados.");
    }
  }
  const response = await fetch(messageUrl, {
    method: editMessageId ? "PATCH" : "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  void response.body?.cancel().catch(() => {});
  if (!response.ok) throw new Error(`Discord returned ${response.status}`);
  return imageMode;
}

async function isUsableBrowserCapture(image: Buffer | undefined): Promise<boolean> {
  if (!image) return false;
  // Browser captures are always requested as PNG. Read the IHDR dimensions
  // directly so a valid capture does not depend on Sharp being installed.
  const isPng =
    image.length >= 24 &&
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47 &&
    image[4] === 0x0d &&
    image[5] === 0x0a &&
    image[6] === 0x1a &&
    image[7] === 0x0a;
  if (!isPng) return false;
  return image.readUInt32BE(16) >= 240 && image.readUInt32BE(20) >= 90;
}

export async function runResendNotification(
  workId: number,
  requestedChapter: string,
  progress?: MonitorProgressReporter,
): Promise<{ title: string; chapter: string; imageMode: MonitorImageMode; parser: string }> {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  if (!config?.discordChannelId) {
    throw new Error("Nenhum canal do Discord foi configurado para o monitor.");
  }

  const [work] = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.id, workId))
    .limit(1);
  if (!work) {
    throw new Error(`Não encontrei nenhuma obra com o ID ${workId}. Use /monitor listar para conferir os IDs.`);
  }

  const wanted = chapterNumberIdentity(requestedChapter);
  if (!wanted) {
    throw new Error("Informe um número de capítulo válido.");
  }

  let listing: ListingSession | undefined;
  try {
    await reportProgress(progress, `Procurando o capítulo ${requestedChapter} de ${work.title}.`);
    listing = await fetchListing(work, progress);

    let chapter = listing.candidates.find(
      (candidate) => chapterNumberIdentity(candidate.number) === wanted,
    );

    if (!chapter) {
      const storedChapters = await db
        .select({
          chapterNumber: detectedChaptersTable.chapterNumber,
          thumbnailUrl: detectedChaptersTable.thumbnailUrl,
          chapterKey: detectedChaptersTable.chapterKey,
        })
        .from(detectedChaptersTable)
        .where(eq(detectedChaptersTable.workId, work.id));
      const stored = storedChapters.find(
        (candidate) => chapterNumberIdentity(candidate.chapterNumber) === wanted,
      );
      if (stored) {
        chapter = {
          number: stored.chapterNumber,
          thumbnailUrl: stored.thumbnailUrl,
          key: stored.chapterKey,
          parser: "histórico salvo",
        };
        await reportProgress(
          progress,
          "O capítulo não está na lista atual; usando a imagem salva no histórico do monitor.",
        );
      }
    }

    if (!chapter) {
      throw new Error(
        `Não encontrei o capítulo ${requestedChapter} na lista atual nem no histórico salvo de **${work.title}**.`,
      );
    }

    const useToptoonPairs = work.platform === "toptoon";
    if (useToptoonPairs) {
      await reportProgress(progress, "Toptoon: tentando as miniaturas 2 e 3; se falharem, usando a principal do mesmo capítulo ou texto.");
    }
    await translateChapterSubtitles([chapter]);
    let capturedImage: Buffer | undefined;
    if (listing.captureSession && chapter.captureId) {
      await reportProgress(progress, "Tentando capturar novamente o card renderizado.");
      try {
        const groups = await listing.captureSession.captureGroups(
          [chapter.captureId], captureSubtitles([chapter], work.platform as MonitorPlatform), useToptoonPairs,
        );
        const group = groups.find((candidate) =>
          candidate.chapterNumbers.some((number) => chapterNumberIdentity(number) === wanted),
        );
        if (group?.image && await isUsableBrowserCapture(group.image)) {
          capturedImage = group.image;
        }
      } catch (error) {
        logger.warn(
          { err: error, workId: work.id, chapter: chapter.number },
          "Falha ao recapturar capítulo para reenvio; usando thumbnail salva",
        );
      }
    }

    await reportProgress(progress, "Enviando novamente a notificação.");
    const imageMode = await postStrip(
      config.discordChannelId,
      work.title,
      [chapter],
      1,
      1,
      false,
      capturedImage,
      useToptoonPairs,
    );

    return {
      title: work.title,
      chapter: chapter.number,
      imageMode,
      parser: listing.parser,
    };
  } finally {
    await listing?.captureSession?.close().catch((error) => {
      logger.warn({ err: error, workId: work.id }, "Falha ao fechar captura após reenvio");
    });
  }
}

export async function runResendGroupNotification(
  workId: number,
  requestedChapters: string[],
  progress?: MonitorProgressReporter,
  editMessageId?: string,
): Promise<{ title: string; chapters: string[]; imageMode: MonitorImageMode; parser: string; edited: boolean }> {
  const identities = requestedChapters.map(chapterNumberIdentity);
  if (
    requestedChapters.length < 2 ||
    requestedChapters.length > 10 ||
    identities.some(identity => !identity) ||
    new Set(identities).size !== identities.length
  ) {
    throw new Error("Informe de 2 a 10 capítulos válidos, sem repetição.");
  }
  if (editMessageId && !/^\d{17,20}$/.test(editMessageId)) {
    throw new Error("O ID da mensagem Discord é inválido.");
  }

  const [config] = await db.select().from(monitorConfigTable).limit(1);
  if (!config?.discordChannelId) throw new Error("Nenhum canal do Discord foi configurado para o monitor.");
  const [work] = await db.select().from(monitoredWorksTable)
    .where(and(eq(monitoredWorksTable.id, workId), eq(monitoredWorksTable.active, true)))
    .limit(1);
  if (!work) throw new Error("A obra não está ativa; confira /monitor listar.");

  let listing: ListingSession | undefined;
  try {
    await reportProgress(progress, `Procurando os capítulos ${requestedChapters.join(", ")} de ${work.title}.`);
    listing = await fetchListing(work, progress);
    const stored = await db.select({
      chapterNumber: detectedChaptersTable.chapterNumber,
      thumbnailUrl: detectedChaptersTable.thumbnailUrl,
      chapterKey: detectedChaptersTable.chapterKey,
    }).from(detectedChaptersTable).where(eq(detectedChaptersTable.workId, work.id));
    const chapters = identities.map((identity, index) => {
      const live = listing!.candidates.find(candidate => chapterNumberIdentity(candidate.number) === identity);
      if (live) return live;
      const saved = stored.find(candidate => chapterNumberIdentity(candidate.chapterNumber) === identity);
      if (saved) {
        return {
          number: saved.chapterNumber,
          thumbnailUrl: saved.thumbnailUrl,
          key: saved.chapterKey,
          parser: "histórico salvo",
        };
      }
      throw new Error(`Não encontrei o capítulo ${requestedChapters[index]} na lista nem no histórico salvo de **${work.title}**.`);
    });
    await translateChapterSubtitles(chapters);
    const useToptoonPairs = work.platform === "toptoon";
    let capturedImage: Buffer | undefined;
    if (listing.captureSession && chapters.every(chapter => chapter.captureId)) {
      await reportProgress(progress, "Capturando o grupo pelo monitor para preservar o cartão original da plataforma.");
      try {
        const groups = await listing.captureSession.captureGroups(
          chapters.map(chapter => chapter.captureId!),
          captureSubtitles(chapters, work.platform as MonitorPlatform),
          useToptoonPairs,
        );
        const selected = new Set(identities);
        const exactGroup = groups.find(group =>
          group.chapterNumbers.length === chapters.length &&
          group.chapterNumbers.every(number => selected.has(chapterNumberIdentity(number))),
        );
        if (exactGroup && await isUsableBrowserCapture(exactGroup.image)) capturedImage = exactGroup.image;
      } catch (error) {
        logger.warn({ err: error, workId: work.id }, "Captura do grupo para reenvio falhou; usando o fallback do monitor");
      }
    }
    const imageMode = await postStrip(
      config.discordChannelId,
      work.title,
      chapters,
      1,
      1,
      false,
      capturedImage,
      useToptoonPairs,
      progress,
      editMessageId,
    );
    return {
      title: work.title,
      chapters: chapters.map(chapter => chapter.number),
      imageMode,
      parser: listing.parser,
      edited: Boolean(editMessageId),
    };
  } finally {
    await listing?.captureSession?.close().catch(error => {
      logger.warn({ err: error, workId }, "Falha ao fechar captura após reenvio agrupado");
    });
  }
}

export async function runTestNotification(
  progress?: MonitorProgressReporter,
  workId?: number,
  topToonPairTest = false,
) {
  await reportProgress(progress, "Iniciando o teste da notificação.");
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  if (!config?.discordChannelId) {
    throw new Error("Nenhum canal do Discord foi configurado para o monitor.");
  }

  const works = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.active, true));
  if (!works.length) {
    throw new Error("Não há nenhum título ativo no monitor para usar no teste.");
  }

  const eligibleWorks = topToonPairTest ? works.filter(work => work.platform === "toptoon") : works;
  const work = workId === undefined
    ? eligibleWorks[Math.floor(Math.random() * eligibleWorks.length)]
    : works.find((candidate) => candidate.id === workId);
  if (!work) {
    throw new Error(
      "A obra selecionada não está mais ativa. Use /monitor listar para conferir a numeração atual.",
    );
  }
  if (topToonPairTest && work.platform !== "toptoon") {
    throw new Error("O teste das imagens 2 e 3 está disponível somente para obras do Toptoon.");
  }
  await reportProgress(progress, `Obra escolhida: ${work.title}.`);
  const listing = await fetchListing(work, progress);
  try {
    const { parser, candidates } = listing;
    if (!candidates.length) {
      throw new Error(`Não encontrei capítulos para o título "${work.title}".`);
    }

    const newest = [...candidates].sort((a, b) => Number(b.number) - Number(a.number));
    const eligible = topToonPairTest
      ? newest.filter(chapter => chapter.extraThumbnailUrls)
      : candidates;
    const chapter = topToonPairTest ? (eligible[0] ?? newest[0])! : eligible[Math.floor(Math.random() * eligible.length)]!;
    if (topToonPairTest) await reportProgress(progress, "Tentando imagens 2 e 3, com a principal como reserva — o mesmo formato usado no monitor automático do Toptoon.");
    await translateChapterSubtitles([chapter]);
    await reportProgress(progress, `Capítulo escolhido: ${chapter.number}. Parser final: ${parser}.`);
    let capturedImage: Buffer | undefined;
    if (listing.captureSession && chapter.captureId && (!topToonPairTest || chapter.extraThumbnailUrls)) {
      await reportProgress(progress, "Tentando capturar o card real renderizado pelo site.");
      try {
        const [group] = await listing.captureSession.captureGroups(
          [chapter.captureId], captureSubtitles([chapter], work.platform as MonitorPlatform), topToonPairTest,
        );
        if (await isUsableBrowserCapture(group?.image)) {
          capturedImage = group?.image;
          await reportProgress(progress, "Captura direta do card concluída.");
        } else {
          logger.warn(
            { title: work.title, chapter: chapter.number },
            "Captura Playwright descartada por dimensões incompatíveis com um card",
          );
          await reportProgress(progress, "A captura direta ficou inválida; usando fallback SVG/Sharp.");
        }
      } catch (error) {
        logger.warn(
          { err: error, title: work.title, chapter: chapter.number },
          "Captura Playwright falhou no teste; usando fallback legado",
        );
        await reportProgress(progress, "A captura direta falhou; usando fallback SVG/Sharp.");
      }
    } else {
      await reportProgress(progress, "A captura direta não está disponível; tentando montagem SVG/Sharp e as reservas.");
    }
    await reportProgress(progress, "Montando e enviando a imagem para o canal do monitor.");
    const imageMode = await postStrip(
      config.discordChannelId,
      work.title,
      [chapter],
      1,
      1,
      true,
      capturedImage,
      topToonPairTest,
      progress,
    );
    await reportProgress(progress, `Mensagem enviada ao Discord (${imageMode}).`);
    const imageSelection: TestImageSelection = imageMode === "none" ? "text"
      : topToonPairTest && imageMode !== "primary+banner" ? "extras" : "primary";

    return {
      title: work.title,
      chapter: chapter.number,
      parser,
      captureMode: imageMode,
      imageSelection,
      channelId: config.discordChannelId,
    };
  } finally {
    await listing.captureSession?.close();
  }
}

export async function runMonitor(client?: Client) {
  return monitorExecution.runRegular(() => measureImageMonitorRound((timing) => runMonitorRound(timing, client)));
}

async function sendLinkRedirectWarning(
  client: Client | undefined,
  config: typeof monitorConfigTable.$inferSelect | undefined,
  work: typeof monitoredWorksTable.$inferSelect,
  inputUrl: string,
  finalUrl?: string,
) {
  if (!client || !config?.discordChannelId) return;
  const platform = work.platform as MonitorPlatform;
  const redirect = getMonitorLinkRedirect(inputUrl, platform, finalUrl);
  const content = formatMonitorLinkWarning(work.title, redirect);
  if (!content) return;

  const status = `Link redirect warning:${monitorLinkWarningKey(work.id, platform, inputUrl)}`;
  const [alreadySent] = await db.select({ id: monitorActivityTable.id })
    .from(monitorActivityTable)
    .where(and(
      eq(monitorActivityTable.workId, work.id),
      eq(monitorActivityTable.status, status),
    ))
    .limit(1);
  if (alreadySent) return;

  try {
    const channel = await client.channels.fetch(config.discordChannelId);
    if (!channel?.isTextBased()) throw new Error("Monitor channel is not text-based");
    const send = (channel as unknown as {
      send?: (payload: { content: string; allowedMentions: { parse: string[] } }) => Promise<unknown>;
    }).send;
    if (!send) throw new Error("Monitor channel cannot receive messages");
    await send.call(channel, { content, allowedMentions: { parse: [] } });
    await db.insert(monitorActivityTable).values({
      workId: work.id,
      chapterCount: 0,
      status,
    });
  } catch (error) {
    logger.warn({ err: error, workId: work.id }, "Could not send monitor link redirect warning");
  }
}

async function runMonitorRound(timing: ImageMonitorTiming, client?: Client) {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const works = (await db.select().from(monitoredWorksTable).where(eq(monitoredWorksTable.active, true)))
    .filter(work => isMonitorPlatformEnabled(work.platform as MonitorPlatform));
  let chaptersFound = 0;
  let postsSent = 0;
  for (const work of works) {
    const workTiming = timing.startWork(work.id, work.title);
    const linkDeltaPending = hasPendingLinkDelta(work.lastStatus);
    const previousLinkUrl = linkDeltaPending
      ? getPendingLinkDeltaPreviousUrl(work.lastStatus)
      : null;
    let listing: ListingSession | undefined;
    let previousListing: ListingSession | undefined;
    try {
      await sendLinkRedirectWarning(client, config, work, work.listingUrl);
      listing = await fetchListing(work);
      await sendLinkRedirectWarning(client, config, work, work.listingUrl, listing.finalUrl);
      let previousLinkNumbers: Set<string> | undefined;
      if (linkDeltaPending && previousLinkUrl) {
        await sendLinkRedirectWarning(client, config, work, previousLinkUrl);
        previousListing = await fetchListing({ ...work, listingUrl: previousLinkUrl });
        await sendLinkRedirectWarning(client, config, work, previousLinkUrl, previousListing.finalUrl);
        if (previousListing.candidates.length === 0) {
          throw new Error("The previous listing returned no usable chapters; link-difference check remains pending");
        }
        previousLinkNumbers = new Set(
          previousListing.candidates.map((candidate) =>
            chapterNumberIdentity(candidate.number),
          ),
        );
        await previousListing.captureSession?.close();
        previousListing = undefined;
      }
      const { parser, candidates } = listing;
      const existing = await db
        .select({
          id: detectedChaptersTable.id,
          key: detectedChaptersTable.chapterKey,
          number: detectedChaptersTable.chapterNumber,
        thumbnailUrl: detectedChaptersTable.thumbnailUrl,
        publishedAt: detectedChaptersTable.publishedAt,
        deliveryPending: detectedChaptersTable.deliveryPending,
        })
        .from(detectedChaptersTable)
        .where(eq(detectedChaptersTable.workId, work.id));
      const checkedAt = new Date();
      const highestExisting = highestTrustedChapterNumber(
        existing.map((chapter) => chapter.number),
      );
      const safeCandidates = candidates.filter((candidate) => {
        const outlier = isAbsurdChapterOutlier(candidate.number, highestExisting);
        if (outlier) {
          logger.warn(
            {
              workId: work.id,
              title: work.title,
              chapter: candidate.number,
              highestKnownChapter: highestExisting,
              parser,
            },
            "Capítulo absurdo ignorado pelo monitor",
          );
        }
        return !outlier;
      });
      const seenKeys = new Set(existing.map((item) => item.key));
      const seenNumbers = new Set(existing.map((item) => chapterNumberIdentity(item.number)));
      const previouslyUnseen = safeCandidates.filter((candidate) =>
        !seenKeys.has(candidate.key) &&
        !seenNumbers.has(chapterNumberIdentity(candidate.number)),
      );
      const isAtOrBelowKnownChapter = (chapter: ChapterCandidate) => {
        const number = numericChapterNumber(chapter.number);
        return highestExisting !== null && number !== null && number <= highestExisting;
      };
      const historical = linkDeltaPending ? [] : previouslyUnseen.filter((candidate) =>
        isHistoricalRelease(candidate, checkedAt) ||
        isReleasedBeforePreviousCheck(candidate, work.lastCheckedAt) ||
        isReleasedBeforeMonitorCreation(candidate, work.createdAt) ||
        isAtOrBelowKnownChapter(candidate),
      );
      let fresh = linkDeltaPending ? previouslyUnseen : previouslyUnseen.filter((candidate) =>
        !isHistoricalRelease(candidate, checkedAt) &&
        !isReleasedBeforePreviousCheck(candidate, work.lastCheckedAt) &&
        !isReleasedBeforeMonitorCreation(candidate, work.createdAt) &&
        !isAtOrBelowKnownChapter(candidate),
      );

      // HTML fallback parsers do not have the card date. If a migration
      // suddenly exposes a large historical range, do not publish the whole
      // backlog; record the older entries and only publish the newest one.
      const freshNumbers = fresh
        .map((chapter) => numericChapterNumber(chapter.number))
        .filter((number): number is number => number !== null);
      const highestFresh = freshNumbers.length ? Math.max(...freshNumbers) : null;
      if (
        !linkDeltaPending &&
        fresh.length >= 5 &&
        fresh.every((chapter) => !chapter.releaseDate) &&
        highestExisting !== null &&
        highestFresh !== null &&
        highestFresh - highestExisting >= 5
      ) {
        const newest = fresh.reduce((current, candidate) =>
          (numericChapterNumber(candidate.number) ?? -Infinity) >
          (numericChapterNumber(current.number) ?? -Infinity)
            ? candidate
            : current,
        );
        historical.push(...fresh.filter((candidate) => candidate !== newest));
        fresh = [newest];
      }

      const lastPublishedNumber = highestTrustedChapterNumber(
        existing
          .filter((chapter) => chapter.publishedAt !== null)
          .map((chapter) => chapter.number),
      );
      const candidateByNumber = new Map(
        safeCandidates.map((chapter) => [
          chapterNumberIdentity(chapter.number),
          chapter,
        ]),
      );
      let pending = existing
          .filter((chapter) => {
            const number = numericChapterNumber(chapter.number);
            return chapter.publishedAt === null &&
              number !== null &&
              (chapter.deliveryPending || (lastPublishedNumber !== null && number > lastPublishedNumber)) &&
              !isAbsurdChapterOutlier(chapter.number, highestExisting);
          })
          .map((chapter): ChapterCandidate =>
            candidateByNumber.get(chapterNumberIdentity(chapter.number)) ?? {
              key: chapter.key,
              number: chapter.number,
              thumbnailUrl: chapter.thumbnailUrl,
              parser: `${parser} recovery`,
            },
          );
      if (previousLinkNumbers) {
        const existingNumbers = new Set(
          existing.map((chapter) => chapterNumberIdentity(chapter.number)),
        );
        const publishedNumbers = new Set(
          existing
            .filter((chapter) => chapter.publishedAt !== null)
            .map((chapter) => chapterNumberIdentity(chapter.number)),
        );
        const linkDifference = safeCandidates.filter((candidate) => {
          const identity = chapterNumberIdentity(candidate.number);
          return !previousLinkNumbers.has(identity) && !publishedNumbers.has(identity);
        });
        fresh = linkDifference.filter(
          (candidate) => !existingNumbers.has(chapterNumberIdentity(candidate.number)),
        );
        pending = linkDifference.filter((candidate) =>
          existingNumbers.has(chapterNumberIdentity(candidate.number)),
        );
      }
      const deliveryNumbers = new Set<string>();
      const toPublish = [...pending, ...fresh].filter(chapter => {
        const identity = chapterNumberIdentity(chapter.number);
        if (deliveryNumbers.has(identity)) return false;
        deliveryNumbers.add(identity);
        return true;
      });

      if (existing.length === 0 && work.lastCheckedAt == null) {
        await db.transaction(async (tx) => {
          if (safeCandidates.length) await tx.insert(detectedChaptersTable).values(safeCandidates.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt })));
          await tx.update(monitoredWorksTable).set({ chaptersSeen: safeCandidates.length, lastCheckedAt: checkedAt, lastStatus: safeCandidates.length ? `${parser}: baseline captured` : `${parser}: no chapters found`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      if (!toPublish.length) {
        await db.transaction(async (tx) => {
          await migrateLegacyKeys(tx, work, existing);
          if (historical.length) {
            await tx.insert(detectedChaptersTable).values(historical.map((chapter) => ({
              workId: work.id,
              chapterKey: chapter.key,
              chapterNumber: chapter.number,
              thumbnailUrl: chapter.thumbnailUrl,
              detectedAt: checkedAt,
            })));
          }
          await tx.update(monitoredWorksTable).set({
            chaptersSeen: existing.length + historical.length,
            lastCheckedAt: checkedAt,
            lastStatus: linkDeltaPending && safeCandidates.length === 0
              ? buildMonitorLinkDeltaPendingStatus(previousLinkUrl ?? undefined)
              : historical.length
                ? `${parser}: historical chapters ignored`
                : safeCandidates.length < candidates.length
                  ? `${parser}: absurd chapter ignored`
                : `${parser}: no new chapters`,
            updatedAt: checkedAt,
          }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      chaptersFound += toPublish.length;
      // Durable intent distinguishes actual deliveries from baseline snapshots.
      await db.transaction(async tx => {
        await migrateLegacyKeys(tx, work, existing);
        if (historical.length) await tx.insert(detectedChaptersTable).values(historical.map(chapter => ({
          workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number,
          thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt,
        }))).onConflictDoNothing();
        if (fresh.length) await tx.insert(detectedChaptersTable).values(fresh.map(chapter => ({
          workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number,
          thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt, deliveryPending: true,
        }))).onConflictDoNothing();
        for (const chapter of pending) {
          const matches = existing.filter(item => chapterNumberIdentity(item.number) === chapterNumberIdentity(chapter.number));
          for (const item of matches) await tx.update(detectedChaptersTable)
            .set({ deliveryPending: true }).where(and(eq(detectedChaptersTable.id, item.id), eq(detectedChaptersTable.workId, work.id)));
        }
      });
      if (!config?.discordChannelId) {
        await db.update(monitoredWorksTable).set({
          chaptersSeen: existing.length + historical.length + fresh.length,
          lastCheckedAt: checkedAt,
          lastStatus: `${parser}: new chapters found — choose a Discord channel`,
          updatedAt: checkedAt,
        }).where(eq(monitoredWorksTable.id, work.id));
        continue;
      }
      await translateChapterSubtitles(toPublish);
      let capturedGroups: CapturedChapterGroup[] = [];
      if (listing.captureSession) {
        try {
          capturedGroups = await listing.captureSession.captureGroups(
            toPublish.map((chapter) => chapter.captureId).filter(Boolean) as string[],
            captureSubtitles(toPublish, work.platform as MonitorPlatform),
            work.platform === "toptoon",
          );
        } catch (error) {
          logger.warn(
            { err: error, workId: work.id },
            "Captura agrupada falhou; usando fallback SVG/Sharp",
          );
        }
      }
      const validCapturedGroups: CapturedChapterGroup[] = [];
      for (const group of capturedGroups) {
        if (!capturedGroupWithinLimit(work.platform as MonitorPlatform, group.chapterNumbers.length)) {
          logger.warn(
            { workId: work.id, chapterNumbers: group.chapterNumbers },
            "Captura agrupada excedeu o limite de capítulos por imagem; usando lotes de fallback",
          );
          continue;
        }
        if (await isUsableBrowserCapture(group.image)) {
          validCapturedGroups.push(group);
        } else {
          logger.warn(
            { workId: work.id, chapterNumbers: group.chapterNumbers },
            "Captura Playwright descartada por dimensões incompatíveis com um card",
          );
        }
      }
      const freshByNumber = new Map(
        toPublish.map((chapter) => [chapter.number, chapter]),
      );
      const browserGroups = validCapturedGroups
        .map((group) => ({
          chapters: group.chapterNumbers
            .map((number) => freshByNumber.get(number))
            .filter(Boolean) as ChapterCandidate[],
          image: group.image,
        }))
        .filter((group) => group.chapters.length > 0);
      const directByKey = new Map<string, { chapters: ChapterCandidate[]; image: Buffer }>();
      for (const group of browserGroups) {
        for (const chapter of group.chapters) {
          directByKey.set(chapter.key, group);
        }
      }

      const groups: Array<{ chapters: ChapterCandidate[]; image?: Buffer }> = [];
      const imageModes = new Set<MonitorImageMode>();
      const emittedDirectKeys = new Set<string>();
      let fallbackChapters: ChapterCandidate[] = [];
      const flushFallback = () => {
        for (let index = 0; index < fallbackChapters.length; index += 5) {
          groups.push({ chapters: fallbackChapters.slice(index, index + 5) });
        }
        fallbackChapters = [];
      };

      // A browser page can expose only part of a long listing at capture time.
      // Do not discard the remaining fresh chapters just because one direct
      // capture succeeded; send uncovered chapters through the normal 5-item
      // fallback batches.
      if (directByKey.size < toPublish.length) {
        logger.warn(
          {
            workId: work.id,
            freshCount: toPublish.length,
            capturedCount: directByKey.size,
          },
          "Captura do monitor ficou parcial — capítulos restantes irão para o fallback",
        );
      }

      for (const chapter of toPublish) {
        const direct = directByKey.get(chapter.key);
        if (!direct) {
          fallbackChapters.push(chapter);
          continue;
        }
        if (emittedDirectKeys.has(chapter.key)) continue;
        flushFallback();
        groups.push(direct);
        for (const capturedChapter of direct.chapters) {
          emittedDirectKeys.add(capturedChapter.key);
        }
      }
      flushFallback();

      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        const imageMode = await postStrip(
          config.discordChannelId,
          work.title,
          group.chapters,
          index + 1,
          groups.length,
          false,
          group.image,
          work.platform === "toptoon",
        );
        imageModes.add(imageMode);
        postsSent++;
        const notifiedAt = new Date();
        // Confirm only this delivered group before attempting the next one.
        await db.transaction(async tx => {
          for (const chapter of group.chapters) {
            const matches = existing.filter(item => chapterNumberIdentity(item.number) === chapterNumberIdentity(chapter.number));
            await tx.update(detectedChaptersTable).set({ publishedAt: notifiedAt, deliveryPending: false })
              .where(and(eq(detectedChaptersTable.workId, work.id), or(
                eq(detectedChaptersTable.chapterKey, buildChapterKey(work.platform as MonitorPlatform, work.title, chapter.number)),
                ...matches.map(item => eq(detectedChaptersTable.id, item.id)),
              )));
          }
          const previousHistory = await tx
            .select({ chapterNumber: monitorHistoryTable.chapterNumber })
            .from(monitorHistoryTable)
            .where(eq(monitorHistoryTable.workId, work.id));
          const historyKeys = new Set(
            previousHistory.map((item) => chapterNumberIdentity(item.chapterNumber)),
          );
          const historyToInsert = group.chapters.filter((chapter) => {
            const key = chapterNumberIdentity(chapter.number);
            if (historyKeys.has(key)) return false;
            historyKeys.add(key);
            return true;
          });
          if (historyToInsert.length) {
            await tx.insert(monitorHistoryTable).values(historyToInsert.map((chapter) => ({
              workId: work.id,
              chapterNumber: chapter.number,
              releaseDate: chapter.releaseDate ?? null,
              notifiedAt,
            })));
          }
          await tx.insert(monitorActivityTable).values({
            workId: work.id,
            chapterCount: group.chapters.length,
            status: `Published (image: ${imageMode})`,
            createdAt: notifiedAt,
          });
          await tx.update(monitoredWorksTable).set({
            chaptersSeen: existing.length + historical.length + fresh.length,
            lastPublishedAt: notifiedAt, updatedAt: notifiedAt,
          }).where(eq(monitoredWorksTable.id, work.id));
        });
      }
      await db.transaction(async (tx) => {
        await tx.update(monitoredWorksTable).set({
          chaptersSeen: existing.length + historical.length + fresh.length,
          lastCheckedAt: checkedAt,
          lastStatus: `${toPublish.length} new chapter${toPublish.length === 1 ? "" : "s"} published (image: ${[...imageModes].join("+")})`,
          updatedAt: checkedAt,
        }).where(eq(monitoredWorksTable.id, work.id));
      });
    } catch (error) {
      logger.warn({ err: error, workId: work.id }, "Work monitor failed");
      void recordBotError({ source: "image_monitor", errorCode: "IMAGE_MONITOR_CHECK_FAILED",
        error, context: { workId: work.id, channelId: config.discordChannelId } });
      workTiming.fail(error);
      await db.update(monitoredWorksTable).set({
        lastCheckedAt: new Date(),
        lastStatus: linkDeltaPending
          ? buildMonitorLinkDeltaPendingStatus(previousLinkUrl ?? undefined)
          : "Check failed",
        updatedAt: new Date(),
      }).where(eq(monitoredWorksTable.id, work.id));
    } finally {
      try {
        await listing?.captureSession?.close();
      } catch (error) {
        workTiming.fail(error);
        throw error;
      } finally {
        try {
          await previousListing?.captureSession?.close();
        } catch (error) {
          workTiming.fail(error);
          throw error;
        }
        workTiming.finish();
      }
    }
  }
  return { status: "completed", worksChecked: works.length, chaptersFound, postsSent };
}