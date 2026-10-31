import type { MonitorPlatform, ParsedChapter } from "./parser-types";

/** Read JSON data, never execute the source's JavaScript. */
function embeddedJson(text: string, start: number): unknown {
  const first = text[start];
  if (first !== "{" && first !== "[") return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < Math.min(text.length, start + 1_000_000); i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

export function cleanChapterSubtitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/<[^>]*>/g, "").replace(/&#x([a-f0-9]+);/gi, (_, n) =>
    Number.parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(Number.parseInt(n, 16)) : "",
  ).replace(/&#(\d+);/g, (_, n) =>
    Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "",
  ).replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > 350 || /^(?:제\s*\d+(?:\.\d+)?\s*화|(?:episode|chapter|cap[ií]tulo|ep\.?)\s*#?\d+(?:\.\d+)?)$/i.test(text)) {
    return undefined;
  }
  return text;
}

function identity(number: string): string {
  const value = Number(number);
  return Number.isFinite(value) ? String(value) : number;
}

/** Exact work matching is essential: jsonData also contains recommendations. */
export function enrichChapterSubtitles<T extends ParsedChapter>(
  html: string, listingUrl: string, platform: MonitorPlatform, chapters: T[],
): T[] {
  const known = new Map<string, string>();
  const extras = new Map<string, [string, string]>();
  if (platform === "toptoon") {
    let slug: string | undefined;
    try {
      slug = decodeURIComponent(new URL(listingUrl).pathname.match(/\/comic\/ep_list\/([^/]+)/)?.[1] ?? "");
    } catch { /* Invalid URL cannot identify a work safely. */ }
    if (slug) {
      const visit = (value: unknown, depth = 0) => {
        if (depth > 8 || !value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) visit(item, depth + 1);
          return;
        }
        const row = value as Record<string, unknown>;
        if (row.id === slug && row.lastUpdated && typeof row.lastUpdated === "object") {
          const latest = row.lastUpdated as Record<string, unknown>;
          const number = String(latest.episodeId ?? "");
          const subtitle = cleanChapterSubtitle(latest.episodeSubTitle);
          if (/^\d+(?:\.\d+)?$/.test(number) && subtitle) known.set(identity(number), subtitle);
        }
        for (const child of Object.values(row)) visit(child, depth + 1);
      };
      for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        const body = script[1];
        for (const marker of body.matchAll(/\bjsonData\s*:\s*(?=[{[])/g)) {
          visit(embeddedJson(body, (marker.index ?? 0) + marker[0].length));
        }
      }
    }
    // Visible subtitles are trusted only within actual Toptoon episode cards.
    for (const card of html.matchAll(/<a\b[^>]*class=['"][^'"]*\bepisode-items\b[^'"]*['"][^>]*>[\s\S]*?<\/a>/gi)) {
      const number = card[0].match(/class=['"]ep_title['"][^>]*>\s*제\s*(\d+(?:\.\d+)?)\s*화/i)?.[1];
      const subtitle = cleanChapterSubtitle(card[0].match(/class=['"]ep_stitle['"][^>]*>([\s\S]*?)<\/p>/i)?.[1]);
      if (number && subtitle) known.set(identity(number), subtitle);
      const workId = card[0].match(/\bdata-comic-id=['"]([^'"]+)['"]/i)?.[1];
      if (number && slug && workId === slug) {
        const pair = [2, 3].map(index => card[0].match(new RegExp(`\\bdata-ep_thumb${index}=['"]([^'"]+)['"]`, "i"))?.[1]);
        const valid = pair.every((value, index) => {
          try {
            const url = new URL(value ?? "");
            return url.protocol === "https:" && url.hostname.endsWith(".toptoon.com") &&
              url.pathname.includes(`/ep_thumb${index + 2}/`) &&
              !/banner|promotion|placeholder|fullversion|locked/i.test(url.pathname);
          } catch { return false; }
        });
        if (valid) extras.set(identity(number), pair as [string, string]);
      }
    }
  }
  const language = html.match(/<html\b[^>]*lang=['"]([a-z]{2}(?:-[a-z]{2})?)['"]/i)?.[1];
  return chapters.map(chapter => {
    const subtitle = cleanChapterSubtitle(chapter.subtitle) ?? known.get(identity(chapter.number));
    const pair = extras.get(identity(chapter.number));
    return {
      ...chapter,
      ...(subtitle ? { subtitle, subtitleLanguage: chapter.subtitleLanguage ?? language } : {}),
      ...(pair ? { extraThumbnailUrls: pair } : {}),
    };
  });
}