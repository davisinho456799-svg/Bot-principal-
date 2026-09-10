import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { MonitorPlatform, ParsedChapter } from "./parsers/index";

const PAGE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_WIDTH = 2_400;
const MAX_CAPTURE_HEIGHT = 4_800;
// Keep the pixels of the real platform card. Padding here would make the
// Discord attachment look like a reconstructed strip instead of the source UI.
const CARD_PADDING = 0;

type ChapterBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserChapter = ParsedChapter & {
  captureId: string;
  captureOrder: number;
};

export type CapturedChapterGroup = {
  chapterNumbers: string[];
  image: Buffer;
};

export type BrowserListingSession = {
  candidates: BrowserChapter[];
  captureGroups(chapterIds: string[]): Promise<CapturedChapterGroup[]>;
  close(): Promise<void>;
};

type BrowserChapterSnapshot = BrowserChapter & {
  box: ChapterBox;
};

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
        args: [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

async function getBrowserContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = getBrowser()
      .then((browser) =>
        browser.newContext({
          viewport: { width: 1_440, height: 1_200 },
          deviceScaleFactor: 1,
          locale: "en-US",
          userAgent:
            process.env.PLAYWRIGHT_USER_AGENT ??
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }),
      )
      .catch((error) => {
        contextPromise = null;
        throw error;
      });
  }
  return contextPromise;
}

async function waitForRenderedPage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: PAGE_TIMEOUT_MS });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);

  await page
    .evaluate(
      `(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
      })()`,
    )
    .catch(() => undefined);
}

/**
 * Detection happens inside the browser. It deliberately selects a chapter
 * card/link, not an arbitrary image. Toptoon banners such as "FULLVERSION
 * APP" therefore never become candidates because they have no chapter marker.
 */
async function findRenderedChapters(
  page: Page,
  platform: MonitorPlatform,
): Promise<BrowserChapterSnapshot[]> {
  const snapshot = (await page.evaluate(
    `(({ platform }) => {
      const CARD_ATTRIBUTE = "data-monitor-capture-card";
      const selector = [
        "a[href]",
        "li",
        "article",
        "[data-episode]",
        "[data-episode-no]",
        "[data-chapter]",
        "[data-chapter-number]",
        "[class*='episode']",
        "[class*='chapter']",
        "[id*='episode']",
        "[id*='chapter']",
        "div"
      ].join(",");
      const blockedWords = /fullversion|full version|download app|app version|promotion|promo/i;
      const chapterLabel = /(?:chapter|episode|episodio|epis[oó]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|ítulo)?|cap\\\\.)/i;
      const chapterPattern = /(?:chapter|episode|episodio|epis[oó]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|ítulo)?|cap\\\\.)\\\\s*(?:#|[-_:])?\\\\s*(\\\\d{1,5}(?:[.,]\\\\d+)?)/ig;
      const hashPattern = /(?:^|\\\\s)#(\\\\d{1,5}(?:[.,]\\\\d+)?)(?=\\\\s|$)/g;
      const numberFromHref = /(?:chapter|episode|episodio|ep|ch|cap)[/_=-](\\\\d{1,5}(?:[.,]\\\\d+)?)/i;
      const platformAttributes = platform === "lezhin"
        ? ["data-episode", "data-episode-no", "data-episode-number"]
        : platform === "toomics"
          ? ["data-episode", "data-episode-no", "data-ep", "data-episode-number"]
          : ["data-episode", "data-episode-no", "data-chapter", "data-chapter-number", "data-ep"];
      const slash = String.fromCharCode(92);
      const digit = slash + "d";
      const whitespace = slash + "s";
      const numberPattern = new RegExp(
        "^" + digit + "{1,5}(?:" + slash + "." + digit + "+)?$",
      );
      const whitespacePattern = new RegExp(whitespace + "+", "g");
      const chapterLabelFixed = new RegExp(
        "(?:chapter|episode|episodio|epis[oó]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|título)?|cap" + slash + ".)",
        "i",
      );
      const chapterPatternFixed = new RegExp(
        "(?:chapter|episode|episodio|epis[oó]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|título)?|cap" +
          slash + ".)" + whitespace + "*(?:#|[-_:])?" + whitespace + "*(" + digit +
          "{1,5}(?:[.,]" + digit + "+)?)",
        "ig",
      );
      const hashPatternFixed = new RegExp(
        "(?:^|" + whitespace + ")#(" + digit + "{1,5}(?:[.,]" + digit + "+)?)(?=" +
          whitespace + "|$)",
        "g",
      );
      const numberFromHrefFixed = new RegExp(
        "(?:chapter|episode|episodio|ep|ch|cap)[/_=-](" + digit +
          "{1,5}(?:[.,]" + digit + "+)?)",
        "i",
      );
      const datePattern = new RegExp(
        "(^|[^0-9])((?:20)?[0-9]{2})[./-]([0-9]{1,2})[./-]([0-9]{1,2})(?=[^0-9]|$)",
        "g",
      );

      const normalizeNumber = (value) =>
        String(value).replace(",", ".").trim().replace(/^0+/, "") || "0";

      const releaseDateFrom = (source) => {
        const match = datePattern.exec(source);
        datePattern.lastIndex = 0;
        if (!match) return "";
        const rawYear = Number(match[2]);
        const year = rawYear < 100 ? 2_000 + rawYear : rawYear;
        const month = Number(match[3]);
        const day = Number(match[4]);
        const date = new Date(Date.UTC(year, month - 1, day, 12));
        return Number.isNaN(date.getTime()) ||
          date.getUTCFullYear() !== year ||
          date.getUTCMonth() !== month - 1 ||
          date.getUTCDate() !== day
          ? ""
          : date.toISOString().slice(0, 10);
      };

      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 2 &&
          rect.height > 2;
      };

      const chapterNumbers = (element) => {
        const values = [];
        const add = (value) => {
          const normalized = normalizeNumber(value);
          if (numberPattern.test(normalized) && !values.includes(normalized)) {
            values.push(normalized);
          }
        };

        for (const attribute of platformAttributes) {
          const value = element.getAttribute(attribute);
          if (value) {
            const match = value.match(new RegExp(digit + "{1,5}(?:[.,]" + digit + ")?"));
            if (match) add(match[0]);
          }
        }

        const href = element.getAttribute("href") || "";
        const hrefMatch = href.match(numberFromHrefFixed);
        if (hrefMatch) add(hrefMatch[1]);

        const text = (element.innerText || element.textContent || " ").replace(whitespacePattern, " ").trim();
        for (const source of [text, ...Array.from(element.attributes).map((attribute) => attribute.value)]) {
          let match;
          while ((match = chapterPatternFixed.exec(source))) add(match[1]);
          chapterPatternFixed.lastIndex = 0;
          while ((match = hashPatternFixed.exec(source))) add(match[1]);
          hashPatternFixed.lastIndex = 0;
        }
        return values;
      };

      const nodes = Array.from(document.querySelectorAll(selector));
      const bestByNumber = new Map();

      for (const element of nodes) {
        if (!visible(element)) continue;
        const text = (element.innerText || element.textContent || " ").replace(whitespacePattern, " ").trim();
        if (!text || text.length > 1_200 || blockedWords.test(text)) continue;

        const numbers = chapterNumbers(element);
        if (!numbers.length || numbers.length > 3) continue;

        const rect = element.getBoundingClientRect();
        const classText = [
          element.id || "",
          element.className && typeof element.className === "string" ? element.className : "",
          ...Array.from(element.attributes).map((attribute) => attribute.name)
        ].join(" ");
        const hasMarker = chapterLabelFixed.test(classText) ||
          platformAttributes.some((attribute) => element.hasAttribute(attribute)) ||
          chapterLabelFixed.test(element.getAttribute("href") || "");
        const hasImage = Boolean(element.querySelector("img, picture, source"));
        const hasLink = element.tagName.toLowerCase() === "a" || Boolean(element.querySelector("a[href]"));
        const hasChapterText = chapterLabelFixed.test(text);
        const hasCardDimensions = rect.width >= 240 && rect.height >= 90;

        // Schedule/status labels such as "Atualizado toda Sex" can carry a
        // chapter-related attribute without being the visual card. A real
        // card must contain media or have dimensions large enough to render
        // the chapter metadata and thumbnail area.
        if (!hasImage && !hasCardDimensions) continue;

        // A platform chapter card is expected to have a marker, link, or
        // image. This rejects the page wrapper and promotional banners.
        if (!hasMarker && !hasChapterText && !hasLink) continue;

        const score =
          (hasMarker ? 80 : 0) +
          (hasChapterText ? 45 : 0) +
          (hasImage ? 25 : 0) +
          (hasLink ? 15 : 0) -
          Math.max(0, numbers.length - 1) * 45 -
          Math.min(text.length, 1_000) / 35 -
          Math.min(rect.width * rect.height / 100_000, 20);

        const thumbnail = element.querySelector("img, source");
        const thumbnailValue = thumbnail
          ? (thumbnail.currentSrc ||
            thumbnail.getAttribute("src") ||
            thumbnail.getAttribute("data-src") ||
            thumbnail.getAttribute("data-original") ||
            thumbnail.getAttribute("data-lazy-src") ||
            thumbnail.getAttribute("data-image") ||
            "")
          : "";

        for (const number of numbers) {
          const previous = bestByNumber.get(number);
          if (!previous || score > previous.score) {
            bestByNumber.set(number, {
              element,
              number,
              score,
              thumbnailUrl: thumbnailValue ? new URL(thumbnailValue, location.href).toString() : "",
              rect: {
                x: rect.left + window.scrollX,
                y: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height
              }
            });
          }
        }
      }

      const records = Array.from(bestByNumber.values())
        .sort((left, right) =>
          left.rect.y - right.rect.y ||
          left.rect.x - right.rect.x ||
          left.number.localeCompare(right.number, undefined, { numeric: true })
        );

      return records.map((record, index) => {
        const captureId = "monitor-card-" + index;
        record.element.setAttribute(CARD_ATTRIBUTE, captureId);
        return {
          number: record.number,
          thumbnailUrl: record.thumbnailUrl,
          releaseDate: releaseDateFrom(
            record.element.innerText || record.element.textContent || "",
          ),
          captureId,
          captureOrder: index,
          box: record.rect
        };
      });
    })(${JSON.stringify({ platform })})`,
  )) as BrowserChapterSnapshot[];

  if (!snapshot.length) return [];

  const imageUrls = snapshot
    .map((chapter) => chapter.thumbnailUrl)
    .filter(Boolean);
  if (imageUrls.length) {
    await page
      .evaluate(
        `((urls) => Promise.all(urls.map((url) => {
          const image = Array.from(document.images).find((candidate) =>
            candidate.currentSrc === url ||
            candidate.src === url ||
            candidate.getAttribute("src") === url
          );
          if (!image || image.complete) return Promise.resolve();
          return new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 4_000);
          });
        })) )(${JSON.stringify(imageUrls)})`,
      )
      .catch(() => undefined);
  }

  return snapshot;
}

function unionBox(chapters: BrowserChapterSnapshot[]): ChapterBox {
  const left = Math.min(...chapters.map((chapter) => chapter.box.x));
  const top = Math.min(...chapters.map((chapter) => chapter.box.y));
  const right = Math.max(
    ...chapters.map((chapter) => chapter.box.x + chapter.box.width),
  );
  const bottom = Math.max(
    ...chapters.map((chapter) => chapter.box.y + chapter.box.height),
  );
  return {
    x: Math.max(0, left - CARD_PADDING),
    y: Math.max(0, top - CARD_PADDING),
    width: right - left + CARD_PADDING * 2,
    height: bottom - top + CARD_PADDING * 2,
  };
}

function fitsTogether(chapters: BrowserChapterSnapshot[]): boolean {
  const box = unionBox(chapters);
  return box.width <= MAX_CAPTURE_WIDTH && box.height <= MAX_CAPTURE_HEIGHT;
}

function makeGreedyGroups(
  candidates: BrowserChapterSnapshot[],
): BrowserChapterSnapshot[][] {
  const groups: BrowserChapterSnapshot[][] = [];
  let current: BrowserChapterSnapshot[] = [];

  for (const candidate of candidates) {
    const next = [...current, candidate];
    const adjacent =
      !current.length ||
      candidate.captureOrder ===
        current[current.length - 1]!.captureOrder + 1;

    if (current.length && (!adjacent || !fitsTogether(next))) {
      groups.push(current);
      current = [];
    }
    current.push(candidate);
  }

  if (current.length) groups.push(current);
  return groups;
}

async function captureGroup(
  page: Page,
  chapters: BrowserChapterSnapshot[],
): Promise<Buffer> {
  const first = chapters[0];
  if (!first) throw new Error("Cannot capture an empty chapter group");

  // Playwright clip coordinates are viewport-relative, while detection stores
  // document-relative boxes. Make the whole selected run fit in the viewport
  // before resolving the final clip; otherwise cards below the fold would
  // produce an "outside the resulting image" screenshot error.
  const documentBox = unionBox(chapters);
  const currentViewport = page.viewportSize();
  await page.setViewportSize({
    width: currentViewport?.width ?? 1_440,
    height: Math.min(
      MAX_CAPTURE_HEIGHT,
      Math.max(1_200, Math.ceil(documentBox.height + 24)),
    ),
  });

  await page
    .locator(`[data-monitor-capture-card="${first.captureId}"]`)
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await page.waitForTimeout(100);

  const boxes = (
    await Promise.all(
      chapters.map((chapter) =>
        page
          .locator(`[data-monitor-capture-card="${chapter.captureId}"]`)
          .boundingBox(),
      ),
    )
  ).filter((box): box is ChapterBox => Boolean(box));

  if (!boxes.length) throw new Error("The selected chapter cards are no longer rendered");
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const clip = {
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: right - left,
    height: bottom - top,
  };

  return page.screenshot({
    type: "png",
    animations: "disabled",
    clip,
  });
}

export async function openBrowserListing(
  listingUrl: string,
  platform: MonitorPlatform,
): Promise<BrowserListingSession> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);

  try {
    await page.goto(listingUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    await waitForRenderedPage(page);
    const candidates = await findRenderedChapters(page, platform);

    return {
      candidates: candidates.map(({ box: _box, ...chapter }) => chapter),
      async captureGroups(chapterIds) {
        const selected = candidates
          .filter((chapter) => chapterIds.includes(chapter.captureId))
          .sort((left, right) => left.captureOrder - right.captureOrder);
        const groups = makeGreedyGroups(selected);
        const captured: CapturedChapterGroup[] = [];

        for (const group of groups) {
          try {
            captured.push({
              chapterNumbers: group.map((chapter) => chapter.number),
              image: await captureGroup(page, group),
            });
          } catch (error) {
            if (group.length === 1) throw error;

            // A site can move cards after a lazy load. Splitting only the
            // failing group keeps the normal path economical without losing
            // the fallback for one problematic card.
            const middle = Math.ceil(group.length / 2);
            for (const smallerGroup of [
              group.slice(0, middle),
              group.slice(middle),
            ]) {
              captured.push({
                chapterNumbers: smallerGroup.map((chapter) => chapter.number),
                image: await captureGroup(page, smallerGroup),
              });
            }
          }
        }
        return captured;
      },
      async close() {
        await page.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }
}