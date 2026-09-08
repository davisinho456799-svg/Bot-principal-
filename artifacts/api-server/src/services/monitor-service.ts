import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@workspace/db";
import {
  detectedChaptersTable,
  monitorActivityTable,
  monitorConfigTable,
  monitoredWorksTable,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";

type ChapterCandidate = {
  key: string;
  number: string;
  thumbnailUrl: string;
};

type MonitorFailure = {
  workId: number;
  title: string;
  message: string;
};

let lastFailureAlertKey: string | null = null;

function parseCandidates(html: string, listingUrl: string, platform: string): ChapterCandidate[] {
  const candidates: ChapterCandidate[] = [];
  const imagePattern = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imagePattern)) {
    const tag = match[0];
    const src = tag.match(/\b(?:src|data-src|data-original)=["']([^"']+)["']/i)?.[1]
      ?? tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1]?.split(",")[0]?.trim().split(" ")[0];
    if (!src) continue;
    const position = match.index ?? 0;
    const context = html.slice(Math.max(0, position - 700), Math.min(html.length, position + 700))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const number = context.match(/(?:chapter|cap[ií]tulo|episode|epis[oó]dio|ep\.?|ch\.?)\s*#?\s*(\d+(?:\.\d+)?)/i)?.[1]
      ?? context.match(/(?:^|\s)#(\d{1,4}(?:\.\d+)?)(?:\s|$)/)?.[1];
    if (!number) continue;
    let thumbnailUrl: string;
    try {
      thumbnailUrl = new URL(src, listingUrl).toString();
    } catch {
      continue;
    }
    const key = `${platform}:${number}:${thumbnailUrl}`;
    if (!candidates.some((candidate) => candidate.key === key)) {
      candidates.push({ key, number, thumbnailUrl });
    }
  }
  return candidates.sort((a, b) => Number(a.number) - Number(b.number));
}

async function fetchListing(url: string, platform: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ChapterMonitor/1.0 (+public-thumbnail-monitor)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`${platform} returned ${response.status}`);
  return parseCandidates(await response.text(), url, platform);
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

function escapeDiscordText(value: string) {
  return value.replace(/[\\`*_~|>]/g, "\\$&").replace(/\r?\n/g, " ").trim();
}

async function postFailureAlert(channelId: string, failures: MonitorFailure[], intervalMinutes: number) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");

  const visibleFailures = failures.slice(0, 10);
  const lines = visibleFailures.map(
    (failure) =>
      `• **${escapeDiscordText(failure.title)}** — ${escapeDiscordText(failure.message).slice(0, 240)}`,
  );
  if (failures.length > visibleFailures.length) {
    lines.push(`• ... e mais ${failures.length - visibleFailures.length} falha(s)`);
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: [
        "⚠️ **Falha no monitoramento**",
        `A última rodada encontrou ${failures.length} erro${failures.length === 1 ? "" : "s"}:`,
        ...lines,
        `Nova tentativa automática em aproximadamente ${intervalMinutes} minuto${intervalMinutes === 1 ? "" : "s"}.`,
      ].join("\n"),
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) throw new Error(`Discord failure alert returned ${response.status}`);
}

export async function runMonitor() {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const works = await db.select().from(monitoredWorksTable).where(eq(monitoredWorksTable.active, true));
  let chaptersFound = 0;
  let postsSent = 0;
  const failures: MonitorFailure[] = [];
  for (const work of works) {
    try {
      const candidates = await fetchListing(work.listingUrl, work.platform);
      const existing = await db.select({ key: detectedChaptersTable.chapterKey }).from(detectedChaptersTable).where(eq(detectedChaptersTable.workId, work.id));
      const seen = new Set(existing.map((item) => item.key));
      const fresh = candidates.filter((candidate) => !seen.has(candidate.key));
      const checkedAt = new Date();
      if (existing.length === 0) {
        await db.transaction(async (tx) => {
          if (candidates.length) await tx.insert(detectedChaptersTable).values(candidates.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt })));
          await tx.update(monitoredWorksTable).set({ chaptersSeen: candidates.length, lastCheckedAt: checkedAt, lastStatus: candidates.length ? "Baseline captured" : "No chapters found", updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        });
        continue;
      }
      if (!fresh.length) {
        await db.update(monitoredWorksTable).set({ lastCheckedAt: checkedAt, lastStatus: "No new chapters", updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        continue;
      }
      chaptersFound += fresh.length;
      if (!config?.discordChannelId) {
        await db.update(monitoredWorksTable).set({ lastCheckedAt: checkedAt, lastStatus: "New chapters found — choose a Discord channel", updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
        continue;
      }
      const chunks = Array.from({ length: Math.ceil(fresh.length / 5) }, (_, index) => fresh.slice(index * 5, index * 5 + 5));
      for (let index = 0; index < chunks.length; index++) {
        await postStrip(config.discordChannelId, work.title, chunks[index], index + 1, chunks.length);
        postsSent++;
      }
      await db.transaction(async (tx) => {
        await tx.insert(detectedChaptersTable).values(fresh.map((chapter) => ({ workId: work.id, chapterKey: chapter.key, chapterNumber: chapter.number, thumbnailUrl: chapter.thumbnailUrl, detectedAt: checkedAt, publishedAt: checkedAt })));
        await tx.insert(monitorActivityTable).values({ workId: work.id, chapterCount: fresh.length, status: "Published" });
        await tx.update(monitoredWorksTable).set({ chaptersSeen: existing.length + fresh.length, lastCheckedAt: checkedAt, lastPublishedAt: checkedAt, lastStatus: `${fresh.length} new chapter${fresh.length === 1 ? "" : "s"} published`, updatedAt: checkedAt }).where(eq(monitoredWorksTable.id, work.id));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ workId: work.id, title: work.title, message });
      logger.warn(
        { err: error, workId: work.id, title: work.title, listingUrl: work.listingUrl },
        "Work monitor failed",
      );
      await db.update(monitoredWorksTable).set({ lastCheckedAt: new Date(), lastStatus: "Check failed", updatedAt: new Date() }).where(eq(monitoredWorksTable.id, work.id));
    }
  }

  if (!failures.length) {
    lastFailureAlertKey = null;
  } else {
    const failureAlertKey = failures.map((failure) => failure.workId).sort((a, b) => a - b).join(",");
    if (config?.discordChannelId && failureAlertKey !== lastFailureAlertKey) {
      try {
        await postFailureAlert(config.discordChannelId, failures, config.intervalMinutes);
        lastFailureAlertKey = failureAlertKey;
      } catch (error) {
        logger.error({ err: error }, "Could not send monitor failure alert");
      }
    }
  }

  logger.info(
    {
      worksChecked: works.length,
      chaptersFound,
      postsSent,
      failures: failures.length,
    },
    "Monitor run completed",
  );

  return { status: "completed", worksChecked: works.length, chaptersFound, postsSent };
}