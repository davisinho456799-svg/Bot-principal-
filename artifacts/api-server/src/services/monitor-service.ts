import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@workspace/db";
import {
  detectedChaptersTable,
  monitorActivityTable,
  monitorConfigTable,
  monitoredWorksTable,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import {
  buildChapterKey,
  genericParser,
  parserForPlatform,
  type MonitorPlatform,
  type ParsedChapter,
  type ParserContext,
} from "./parsers/index";
import {
  openBrowserListing,
  type BrowserChapter,
  type BrowserListingSession,
  type CapturedChapterGroup,
} from "./browser-chapter-capture";

type ChapterCandidate = ParsedChapter & {
  key: string;
  parser: string;
  captureId?: string;
};

function chapterNumberIdentity(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}

type ExistingChapter = {
  id: number;
  key: string;
  number: string;
};

const HISTORICAL_RELEASE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

function numericChapterNumber(value: string): number | null {
  const number = Number(value.replace(",", ".").trim());
  return Number.isFinite(number) ? number : null;
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
  captureSession?: BrowserListingSession;
};

async function fetchListing(
  work: typeof monitoredWorksTable.$inferSelect,
): Promise<ListingSession> {
  const platform = work.platform as MonitorPlatform;
  const context: ParserContext = {
    listingUrl: work.listingUrl,
    platform,
    workTitle: work.title,
  };

  try {
    const browserListing = await openBrowserListing(work.listingUrl, platform);
    if (browserListing.candidates.length) {
      const browserCandidates = browserListing.candidates as BrowserChapter[];
      return {
        parser: "Playwright browser",
        candidates: withChapterKeys(
          browserCandidates,
          platform,
          work.title,
          "Playwright browser",
        ),
        captureSession: browserListing,
      };
    }
    await browserListing.close();
    logger.debug({ workId: work.id }, "Playwright encontrou a página, mas não encontrou capítulos");
  } catch (error) {
    logger.warn(
      { err: error, workId: work.id, platform },
      "Playwright falhou; usando parser HTML como fallback",
    );
  }

  const specificParser = parserForPlatform(work.platform);

  if (specificParser) {
    try {
      const specificChapters = await specificParser.parse(context);
      if (specificChapters.length) {
        return {
          parser: specificParser.name,
          candidates: withChapterKeys(specificChapters, platform, work.title, specificParser.name),
        };
      }
      logger.debug({ workId: work.id, parser: specificParser.name }, "Specific parser found no chapters; using generic parser");
    } catch (error) {
      logger.warn({ err: error, workId: work.id, parser: specificParser.name }, "Specific parser failed; using generic parser");
    }
  }

  const genericChapters = await genericParser.parse(context);
  return {
    parser: specificParser ? `${genericParser.name} (fallback)` : genericParser.name,
    candidates: withChapterKeys(genericChapters, platform, work.title, genericParser.name),
  };
}

async function downloadThumbnail(url: string): Promise<Buffer | null> {
  try {
    if (/fullversion|full[-_ ]?version|download[-_ ]?app|app[-_ ]?version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)/i.test(url)) {
      return null;
    }
    const response = await fetch(url, { headers: { "User-Agent": "ChapterMonitor/1.0" } });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height) return null;
    const stats = await sharp(bytes).stats();
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
): Promise<Buffer> {
  const rowHeight = 164;
  const width = 920;
  const headerHeight = 92;
  const height = headerHeight + chapters.length * rowHeight + 24;
  const images = await Promise.all(chapters.map(async (chapter) => ({
    chapter,
    data: await downloadThumbnail(chapter.thumbnailUrl),
  })));
  const imageRows = images.map(({ chapter, data }, index) => {
    const y = headerHeight + index * rowHeight;
    return `<rect x="24" y="${y}" width="872" height="140" rx="14" fill="#f5f0e8" stroke="#ded5c8"/><text x="52" y="${y + 78}" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">EP ${escapeXml(chapter.number)}</text>${data ? "" : `<text x="185" y="${y + 78}" fill="#7a746c" font-family="Arial,sans-serif" font-size="18">Thumbnail unavailable</text>`}`;
  }).join("");
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fffaf3"/><text x="34" y="44" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">${escapeXml(title)}</text><text x="34" y="70" fill="#d8624c" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">NEW CHAPTERS · ${chapters.length}</text>${imageRows}</svg>`;
  let output = await sharp(Buffer.from(baseSvg)).png().toBuffer();
  const composites = await Promise.all(images.map(async ({ data }, index) => {
    if (!data) return null;
    const thumbnail = await sharp(data)
      .resize(690, 120, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    return {
      input: thumbnail,
      left: 185,
      top: headerHeight + index * rowHeight + 10,
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

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[character] ?? character);
}

async function postStrip(
  channelId: string,
  title: string,
  chapters: ChapterCandidate[],
  part: number,
  total: number,
  isTest = false,
  capturedImage?: Buffer,
) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  // The browser path sends the pixels rendered by the platform. The SVG/Sharp
  // renderer remains as a last-resort compatibility fallback when a browser
  // is unavailable or a page does not expose a stable card.
  const png =
    capturedImage ?? await buildStrip(title, chapters);
  const form = new FormData();
  const chapterSummary = chapters.length === 1
    ? `1 capítulo novo · capítulo ${chapters[0].number}`
    : `${chapters.length} capítulos novos · capítulos ${chapters.map((chapter) => chapter.number).join(", ")}`;
  form.append("payload_json", JSON.stringify({
    content: `${isTest ? "🧪 **TESTE** · " : ""}**${title}** · ${chapterSummary}${total > 1 ? ` · parte ${part}/${total}` : ""}`,
    allowed_mentions: { parse: [] },
  }));
  const pngBlob = new Blob([png], { type: "image/png" });
  form.append("files[0]", pngBlob, `chapter-release-${isTest ? "test-" : ""}${Date.now()}-${part}.png`);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord returned ${response.status}`);
}

async function isUsableBrowserCapture(image: Buffer | undefined): Promise<boolean> {
  if (!image) return false;
  try {
    const metadata = await sharp(image).metadata();
    return (metadata.width ?? 0) >= 240 && (metadata.height ?? 0) >= 90;
  } catch {
    return false;
  }
}

export async function runTestNotification() {
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

  const work = works[Math.floor(Math.random() * works.length)];
  const listing = await fetchListing(work);
  try {
    const { parser, candidates } = listing;
    if (!candidates.length) {
      throw new Error(`Não encontrei capítulos para o título "${work.title}".`);
    }

    const chapter = candidates[Math.floor(Math.random() * candidates.length)]!;
    let capturedImage: Buffer | undefined;
    if (listing.captureSession && chapter.captureId) {
      try {
        const [group] = await listing.captureSession.captureGroups([chapter.captureId]);
        if (await isUsableBrowserCapture(group?.image)) {
          capturedImage = group?.image;
        } else {
          logger.warn(
            { title: work.title, chapter: chapter.number },
            "Captura Playwright descartada por dimensões incompatíveis com um card",
          );
        }
      } catch (error) {
        logger.warn(
          { err: error, title: work.title, chapter: chapter.number },
          "Captura Playwright falhou no teste; usando fallback legado",
        );
      }
    }
    await postStrip(
      config.discordChannelId,
      work.title,
      [chapter],
      1,
      1,
      true,
      capturedImage,
    );

    return {
      title: work.title,
      chapter: chapter.number,
      parser,
      captureMode: capturedImage ? "captura direta do card" : "fallback SVG/Sharp",
      channelId: config.discordChannelId,
    };
  } finally {
    await listing.captureSession?.close();
  }
}

export async function runMonitor() {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const works = await db.select().from(monitoredWorksTable).where(eq(monitoredWorksTable.active, true));
  let chaptersFound = 0;
  let postsSent = 0;
  for (const work of works) {
    let listing: ListingSession | undefined;
    try {
      listing = await fetchListing(work);
      const { parser, candidates } = listing;
      const existing = await db
        .select({
          id: detectedChaptersTable.id,
          key: detectedChaptersTable.chapterKey,
          number: detectedChaptersTable.chapterNumber,
        })
        .from(detectedChaptersTable)
        .where(eq(detectedChaptersTable.workId, work.id));
      const checkedAt = new Date();
      const seenKeys = new Set(existing.map((item) => item.key));
      const seenNumbers = new Set(existing.map((item) => chapterNumberIdentity(item.number)));
      const previouslyUnseen = candidates.filter((candidate) =>
        !seenKeys.has(candidate.key) &&
        !seenNumbers.has(chapterNumberIdentity(candidate.number)),
      );
      const historical = previouslyUnseen.filter((candidate) =>
        isHistoricalRelease(candidate, checkedAt),
      );
      let fresh = previouslyUnseen.filter((candidate) =>
        !isHistoricalRelease(candidate, checkedAt),
      );

      // HTML fallback parsers do not have the card date. If a migration
      // suddenly exposes a large historical range, do not publish the whole
      // backlog; record the older entries and only publish the newest one.
      const existingNumbers = existing
        .map((chapter) => numericChapterNumber(chapter.number))
        .filter((number): number is number => number !== null);
      const freshNumbers = fresh
        .map((chapter) => numericChapterNumber(chapter.number))
        .filter((number): number is number => number !== null);
      const highestExisting = existingNumbers.length ? Math.max(...existingNumbers) : null;
      const highestFresh = freshNumbers.length ? Math.max(...freshNumbers) : null;
      if (
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

      if (existing.length === 0) {
        await db.transaction(async (tx) => {
          if (candidates.length) await tx.insert(detectedChaptersTable).values(candidates.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt })));
          await tx.update(monitoredWorksTable).set({ chaptersSeen: candidates.length, lastCheckedAt: checkedAt, lastStatus: candidates.length ? `${parser}: baseline captured` : `${parser}: no chapters found`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      if (!fresh.length) {
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
            lastStatus: historical.length
              ? `${parser}: historical chapters ignored`
              : `${parser}: no new chapters`,
            updatedAt: checkedAt,
          }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      chaptersFound += fresh.length;
      if (historical.length) {
        await db.insert(detectedChaptersTable).values(historical.map((chapter) => ({
          workId: work.id,
          chapterKey: chapter.key,
          chapterNumber: chapter.number,
          thumbnailUrl: chapter.thumbnailUrl,
          detectedAt: checkedAt,
        })));
      }
      if (!config?.discordChannelId) {
        await db.update(monitoredWorksTable).set({
          chaptersSeen: existing.length + historical.length,
          lastCheckedAt: checkedAt,
          lastStatus: `${parser}: new chapters found — choose a Discord channel`,
          updatedAt: checkedAt,
        }).where(eq(monitoredWorksTable.id, work.id));
        continue;
      }
      let capturedGroups: CapturedChapterGroup[] = [];
      if (listing.captureSession) {
        try {
          capturedGroups = await listing.captureSession.captureGroups(
            fresh.map((chapter) => chapter.captureId).filter(Boolean) as string[],
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
        fresh.map((chapter) => [chapter.number, chapter]),
      );
      const browserGroups = validCapturedGroups
        .map((group) => ({
          chapters: group.chapterNumbers
            .map((number) => freshByNumber.get(number))
            .filter(Boolean) as ChapterCandidate[],
          image: group.image,
        }))
        .filter((group) => group.chapters.length > 0);
      const groups: Array<{ chapters: ChapterCandidate[]; image?: Buffer }> =
        browserGroups.length
          ? browserGroups
          : Array.from(
              { length: Math.ceil(fresh.length / 5) },
              (_, index) => ({
                chapters: fresh.slice(index * 5, index * 5 + 5),
              }),
            );

      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        await postStrip(
          config.discordChannelId,
          work.title,
          group.chapters,
          index + 1,
          groups.length,
          false,
          group.image,
        );
        postsSent++;
      }
      await db.transaction(async (tx) => {
        await migrateLegacyKeys(tx, work, existing);
        await tx.insert(detectedChaptersTable).values(fresh.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt, publishedAt: checkedAt })));
        await tx.insert(monitorActivityTable).values({ workId: work.id, chapterCount: fresh.length, status: "Published" });
        await tx.update(monitoredWorksTable).set({ chaptersSeen: existing.length + historical.length + fresh.length, lastCheckedAt: checkedAt, lastPublishedAt: checkedAt, lastStatus: `${fresh.length} new chapter${fresh.length === 1 ? "" : "s"} published`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
      });
    } catch (error) {
      logger.warn({ err: error, workId: work.id }, "Work monitor failed");
      await db.update(monitoredWorksTable).set({ lastCheckedAt: new Date(), lastStatus: "Check failed", updatedAt: new Date() }).where(eq(monitoredWorksTable.id, work.id));
    } finally {
      await listing?.captureSession?.close();
    }
  }
  return { status: "completed", worksChecked: works.length, chaptersFound, postsSent };
}