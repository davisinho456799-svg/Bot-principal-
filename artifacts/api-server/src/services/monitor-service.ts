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

type ChapterCandidate = ParsedChapter & {
  key: string;
  parser: string;
};

function chapterNumberIdentity(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}

type ExistingChapter = {
  id: number;
  key: string;
  number: string;
};

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

async function fetchListing(work: typeof monitoredWorksTable.$inferSelect) {
  const platform = work.platform as MonitorPlatform;
  const context: ParserContext = {
    listingUrl: work.listingUrl,
    platform,
    workTitle: work.title,
  };
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

async function downloadAsDataUri(url: string) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "ChapterMonitor/1.0" } });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

async function buildStrip(title: string, chapters: ChapterCandidate[]) {
  const rowHeight = 164;
  const width = 920;
  const headerHeight = 92;
  const height = headerHeight + chapters.length * rowHeight + 24;
  const images = await Promise.all(chapters.map(async (chapter) => ({
    chapter,
    data: await downloadAsDataUri(chapter.thumbnailUrl),
  })));
  const imageRows = images.map(({ chapter, data }, index) => {
    const y = headerHeight + index * rowHeight;
    return `<rect x="24" y="${y}" width="872" height="140" rx="14" fill="#f5f0e8" stroke="#ded5c8"/><text x="52" y="${y + 78}" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">EP ${escapeXml(chapter.number)}</text>${data ? `<image href="${data}" x="185" y="${y + 10}" width="690" height="120" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 10px)"/>` : `<text x="185" y="${y + 78}" fill="#7a746c" font-family="Arial,sans-serif" font-size="18">Thumbnail unavailable</text>`}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fffaf3"/><text x="34" y="44" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">${escapeXml(title)}</text><text x="34" y="70" fill="#d8624c" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">NEW CHAPTERS · ${chapters.length}</text>${imageRows}</svg>`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[character] ?? character);
}

async function postStrip(channelId: string, title: string, chapters: ChapterCandidate[], part: number, total: number) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  const svg = await buildStrip(title, chapters);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    content: `**${title}** · ${chapters.length} capítulo${chapters.length === 1 ? "" : "s"} novo${chapters.length === 1 ? "" : "s"}${total > 1 ? ` · parte ${part}/${total}` : ""}`,
    allowed_mentions: { parse: [] },
  }));
  form.append("files[0]", new Blob([png], { type: "image/png" }), `chapter-release-${Date.now()}-${part}.png`);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord returned ${response.status}`);
}

export async function runMonitor() {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const works = await db.select().from(monitoredWorksTable).where(eq(monitoredWorksTable.active, true));
  let chaptersFound = 0;
  let postsSent = 0;
  for (const work of works) {
    try {
      const { parser, candidates } = await fetchListing(work);
      const existing = await db
        .select({
          id: detectedChaptersTable.id,
          key: detectedChaptersTable.chapterKey,
          number: detectedChaptersTable.chapterNumber,
        })
        .from(detectedChaptersTable)
        .where(eq(detectedChaptersTable.workId, work.id));
      const seenKeys = new Set(existing.map((item) => item.key));
      const seenNumbers = new Set(existing.map((item) => chapterNumberIdentity(item.number)));
      const fresh = candidates.filter((candidate) =>
        !seenKeys.has(candidate.key) &&
        !seenNumbers.has(chapterNumberIdentity(candidate.number)),
      );
      const checkedAt = new Date();
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
          await tx.update(monitoredWorksTable).set({ lastCheckedAt: checkedAt, lastStatus: `${parser}: no new chapters`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      chaptersFound += fresh.length;
      if (!config?.discordChannelId) {
        await db.update(monitoredWorksTable).set({ lastCheckedAt: checkedAt, lastStatus: `${parser}: new chapters found — choose a Discord channel`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        continue;
      }
      const chunks = Array.from({ length: Math.ceil(fresh.length / 5) }, (_, index) => fresh.slice(index * 5, index * 5 + 5));
      for (let index = 0; index < chunks.length; index++) {
        await postStrip(config.discordChannelId, work.title, chunks[index], index + 1, chunks.length);
        postsSent++;
      }
      await db.transaction(async (tx) => {
        await migrateLegacyKeys(tx, work, existing);
        await tx.insert(detectedChaptersTable).values(fresh.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt, publishedAt: checkedAt })));
        await tx.insert(monitorActivityTable).values({ workId: work.id, chapterCount: fresh.length, status: "Published" });
        await tx.update(monitoredWorksTable).set({ chaptersSeen: existing.length + fresh.length, lastCheckedAt: checkedAt, lastPublishedAt: checkedAt, lastStatus: `${fresh.length} new chapter${fresh.length === 1 ? "" : "s"} published`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
      });
    } catch (error) {
      logger.warn({ err: error, workId: work.id }, "Work monitor failed");
      await db.update(monitoredWorksTable).set({ lastCheckedAt: new Date(), lastStatus: "Check failed", updatedAt: new Date() }).where(eq(monitoredWorksTable.id, work.id));
    }
  }
  return { status: "completed", worksChecked: works.length, chaptersFound, postsSent };
}