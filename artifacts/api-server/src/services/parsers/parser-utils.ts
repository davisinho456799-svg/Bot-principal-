import type { MonitorPlatform, ParsedChapter, ParserContext } from "./parser-types";

const USER_AGENT = "ChapterMonitor/1.0 (+public-thumbnail-monitor)";

export async function fetchPageHtml(url: string, platform: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${platform} returned ${response.status}`);
  return response.text();
}

function resolveUrl(value: string, listingUrl: string): string | null {
  try {
    return new URL(value, listingUrl).toString();
  } catch {
    return null;
  }
}

function getAttribute(tag: string, names: string[]): string | null {
  for (const name of names) {
    const value = tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1];
    if (value) return value;
  }
  return null;
}

function getThumbnail(markup: string, listingUrl: string): string | null {
  const image = markup.match(/<img\b[^>]*>/i)?.[0] ?? markup.match(/<source\b[^>]*>/i)?.[0];
  if (image) {
    const src = getAttribute(image, ["src", "data-src", "data-original", "data-lazy-src", "data-image"]);
    const srcset = getAttribute(image, ["srcset", "data-srcset"]);
    const candidate = src ?? srcset?.split(",")[0]?.trim().split(/\s+/)[0];
    if (candidate) return resolveUrl(candidate, listingUrl);
  }

  const background = markup.match(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1];
  return background ? resolveUrl(background, listingUrl) : null;
}

function cleanText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumber(value: string): string {
  return value.replace(/^#/, "").trim();
}

function extractChapterNumber(markup: string, href: string | null, specific: boolean): string | null {
  const text = cleanText(markup);
  const sources = [markup, href ?? "", text];
  const patterns = specific
    ? [
        /data-(?:episode|chapter)(?:[-_](?:number|no))?\s*=\s*["']#?(\d+(?:\.\d+)?)/i,
        /["'](?:episode|chapter)(?:Number|No|Index)?["']\s*:\s*["']?#?(\d+(?:\.\d+)?)/i,
        /(?:episode|chapter|ep|ch)[^0-9]{0,12}#?(\d+(?:\.\d+)?)/i,
        /(?:episode|chapter|ep|ch)[^/?#"'=]*[/?=_-]+#?(\d+(?:\.\d+)?)/i,
      ]
    : [
        /(?:chapter|cap[ií]tulo|episode|epis[oó]dio|ep\.?|ch\.?)\s*#?\s*(\d+(?:\.\d+)?)/i,
        /(?:^|\s)#(\d{1,4}(?:\.\d+)?)(?:\s|$)/i,
      ];

  for (const source of sources) {
    for (const pattern of patterns) {
      const match = source.match(pattern)?.[1];
      if (match) return normalizeNumber(match);
    }
  }
  return null;
}

function dedupeChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  const seen = new Set<string>();
  return chapters
    .filter((chapter) => {
      const key = `${chapter.number}|${chapter.thumbnailUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Number(left.number) - Number(right.number));
}

export function parseGenericChapterHtml(
  html: string,
  listingUrl: string,
): ParsedChapter[] {
  const candidates: ParsedChapter[] = [];
  const imagePattern = /<img\b[^>]*>/gi;

  for (const match of html.matchAll(imagePattern)) {
    const tag = match[0];
    const thumbnail = getThumbnail(tag, listingUrl);
    if (!thumbnail) continue;
    const position = match.index ?? 0;
    const context = html.slice(
      Math.max(0, position - 700),
      Math.min(html.length, position + 700),
    );
    const number = extractChapterNumber(context, null, false);
    if (number) candidates.push({ number, thumbnailUrl: thumbnail });
  }

  return dedupeChapters(candidates);
}

type PlatformMarkupRules = {
  platform: MonitorPlatform;
  cardPattern: RegExp;
  chapterAttributes: string[];
};

function parsePlatformCards(
  html: string,
  listingUrl: string,
  rules: PlatformMarkupRules,
): ParsedChapter[] {
  const candidates: ParsedChapter[] = [];
  for (const match of html.matchAll(rules.cardPattern)) {
    const markup = match[0];
    const href = getAttribute(markup, ["href", "data-href", "data-url"]);
    const number = extractChapterNumber(markup, href, true);
    const thumbnail = getThumbnail(markup, listingUrl);
    if (number && thumbnail) candidates.push({ number, thumbnailUrl: thumbnail });
  }

  // Some localized pages render the chapter metadata on a wrapper and the
  // image in a sibling. Keep a targeted fallback for explicit platform data
  // attributes without replacing the generic parser.
  if (!candidates.length) {
    const markerPattern = new RegExp(
      `<(?:li|div|article)\\b[^>]*(?:${rules.chapterAttributes.join("|")})[^>]*>[\\s\\S]{0,2200}?</(?:li|div|article)>`,
      "gi",
    );
    for (const match of html.matchAll(markerPattern)) {
      const markup = match[0];
      const number = extractChapterNumber(markup, getAttribute(markup, ["href", "data-href", "data-url"]), true);
      const thumbnail = getThumbnail(markup, listingUrl);
      if (number && thumbnail) candidates.push({ number, thumbnailUrl: thumbnail });
    }
  }

  return dedupeChapters(candidates);
}

export function parsePlatformChapterHtml(
  html: string,
  listingUrl: string,
  platform: MonitorPlatform,
): ParsedChapter[] {
  const rules: PlatformMarkupRules = {
    platform,
    cardPattern: /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    chapterAttributes:
      platform === "lezhin"
        ? ["data-episode", "data-episode-no", "episodeNumber", "episodeNo"]
        : platform === "toomics"
          ? ["data-episode", "data-episode-no", "data-ep", "episodeNo"]
          : ["data-episode", "data-chapter", "data-episode-no", "chapterNumber", "episodeNo"],
  };
  return parsePlatformCards(html, listingUrl, rules);
}

export function buildChapterKey(
  platform: MonitorPlatform,
  workTitle: string,
  chapterNumber: string,
): string {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .toLocaleLowerCase("pt-BR")
      .replace(/\s+/g, " ")
      .replace(/[|:#]/g, "")
      .replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff ._-]/gi, "");

  return `${normalize(platform)}|${normalize(workTitle)}|${normalize(chapterNumber)}`;
}

export async function parseWithPlatformMarkup(
  context: ParserContext,
): Promise<ParsedChapter[]> {
  const html = await fetchPageHtml(context.listingUrl, context.platform);
  return parsePlatformChapterHtml(html, context.listingUrl, context.platform);
}