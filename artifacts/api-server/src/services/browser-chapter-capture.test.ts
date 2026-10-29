import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { applyCaptureSubtitles } from "./chapter-subtitle-capture";
import { applyToptoonPairCapture } from "./toptoon-pair-capture";
import {
  capturedGroupWithinLimit,
  discoverToomicsLoginUrls,
  findRenderedChapters,
  inspectToomicsLoginFrames,
  isolatePrimaryThumbnails,
  makeGreedyGroups,
  promotePrimaryThumbnails,
  shouldClickToomicsLoginLink,
  TOOMICS_LOGIN_LINK_SELECTOR,
  toomicsLoginUrls,
  type BrowserChapterSnapshot,
  type CaptureThumbnailTarget,
} from "./browser-chapter-capture";

describe("Toomics login URLs", () => {
  it("tries the listing homepage and Toomics host variants", () => {
    expect(toomicsLoginUrls(
      "https://www.toomics.com/uplms/episode/toon/7189",
      "about:blank",
    )).toEqual([
      "https://global.toomics.com/por/login",
      "https://www.toomics.com/por/login",
      "https://www.toomics.com/",
      "https://toomics.com/por/login",
      "https://toomics.com/",
      "https://global.toomics.com/",
    ]);
  });

  it("ignores non-Toomics listing origins", () => {
    expect(toomicsLoginUrls(
      "https://example.com/work",
      "about:blank",
    )).toEqual([
      "https://global.toomics.com/por/login",
      "https://toomics.com/por/login",
      "https://toomics.com/",
      "https://www.toomics.com/por/login",
      "https://www.toomics.com/",
      "https://global.toomics.com/",
    ]);
  });
  it("avoids click redirects on dedicated login pages", () => {
    expect(shouldClickToomicsLoginLink("https://global.toomics.com/por/login")).toBe(false);
    expect(shouldClickToomicsLoginLink("https://www.toomics.com/kr/login?return=/episode")).toBe(false);
    expect(shouldClickToomicsLoginLink("https://www.toomics.com/")).toBe(true);
  });
  it("prefers discovered same-site login routes and rejects external links", () => {
    expect(toomicsLoginUrls(
      "https://www.toomics.com/uplmscg/episode/toon/7189",
      "about:blank",
      ["https://www.toomics.com/uplmscg/login?return=/episode", "https://example.com/login"],
    )).toEqual([
      "https://global.toomics.com/por/login",
      "https://www.toomics.com/uplmscg/login",
      "https://www.toomics.com/por/login",
      "https://www.toomics.com/",
      "https://toomics.com/por/login",
      "https://toomics.com/",
      "https://global.toomics.com/",
    ]);
  });

  it("reads visible login links from the actual listing page", async () => {
    const page = await browser.newPage();
    await page.setContent(`<base href="https://www.toomics.com/uplmscg/episode/toon/7189">
      <a href="/uplmscg/login">로그인</a>
      <a href="/uplmscg/home">Home</a>
      <a href="https://example.com/login">Login</a>
      <a href="/uplmscg/hidden-login" style="display:none">Login</a>`);
    const discovered = await discoverToomicsLoginUrls(page);
    expect(discovered).toContain("https://www.toomics.com/uplmscg/login");
    expect(discovered).not.toContain("https://www.toomics.com/uplmscg/hidden-login");
    expect(toomicsLoginUrls("https://www.toomics.com/uplmscg/episode/toon/7189", "about:blank", discovered))
      .not.toContain("https://example.com/login");
    await page.close();
  });
  it("opens the login modal from a JavaScript Korean login link", async () => {
    const page = await browser.newPage();
    await page.setContent(`<div id="login" style="display:none">
      <input id="user_id" type="email"><input id="user_pw" type="password">
    </div>
    <a href="javascript:void(0)" onclick="document.querySelector('#login').style.display='block'">로그인</a>`);

    const loginLink = page.locator(TOOMICS_LOGIN_LINK_SELECTOR).first();
    expect(await loginLink.isVisible()).toBe(true);
    await loginLink.click();
    expect(await page.locator("#user_id:visible").count()).toBe(1);
    expect(await page.locator("#user_pw:visible").count()).toBe(1);
    await page.close();
  });

  it("reports login field presence and visibility by frame without reading field values", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <input id="user_id" type="text" value="private-user" style="display:none">
      <input id="user_pw" type="password" value="private-password">
    </form>
    <iframe srcdoc="<form><input id=&quot;user_id&quot; type=&quot;text&quot;><input id=&quot;user_pw&quot; type=&quot;password&quot;></form>"></iframe>`);
    await page.waitForTimeout(100);
    const frames = await inspectToomicsLoginFrames([page]);
    const mainFrame = frames.find((frame) => frame.forms === 1 && frame.userIdFields === 1);
    const childFrame = frames.find((frame) => frame.userIdFields === 1 && frame.page !== mainFrame?.page);
    expect(mainFrame).toMatchObject({ userIdFields: 1, visibleUserIdFields: 0, userPwFields: 1, visibleUserPwFields: 1, passwordFields: 1, visiblePasswordFields: 1 });
    expect(childFrame).toMatchObject({ userIdFields: 1, visibleUserIdFields: 1, userPwFields: 1, visibleUserPwFields: 1 });
    expect(JSON.stringify(frames)).not.toContain("private-user");
    expect(JSON.stringify(frames)).not.toContain("private-password");
    await page.close();
  });
});

let browser: Browser;

beforeAll(async () => {
  const systemChromium = "/repl/tools/bin/chromium";
  const executablePath =
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
    (existsSync(systemChromium) ? systemChromium : undefined);
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
});

afterAll(async () => {
  await browser?.close();
});

function svgDataUrl(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72"><rect width="96" height="72" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function countSolidColorPixels(
  screenshot: Buffer,
  color: [number, number, number],
) {
  const { data, info } = await sharp(screenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (
      data[offset] === color[0] &&
      data[offset + 1] === color[1] &&
      data[offset + 2] === color[2]
    ) {
      count += 1;
    }
  }
  return count;
}

describe("single-thumbnail chapter capture", () => {
  it("keeps the complete primary artwork visible when the source card uses cover cropping", async () => {
    const page = await browser.newPage();
    const portrait = `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="120"><rect width="40" height="60" fill="#d43b35"/><rect y="60" width="40" height="60" fill="#37a36b"/></svg>',
    )}`;
    await page.setContent(`<article data-monitor-capture-card="portrait"
      style="width:140px;height:100px">
      <img src="${portrait}" style="width:120px;height:90px;object-fit:cover">
    </article>`);
    await page.waitForFunction(() => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement && image.complete && image.naturalHeight > 0;
    });

    await isolatePrimaryThumbnails(page, [{
      captureId: "portrait",
      thumbnailUrl: portrait,
    }]);

    expect(await page.locator("img").evaluate(image => getComputedStyle(image).objectFit)).toBe("contain");
    const screenshot = await page.locator("article").screenshot();
    expect(await countSolidColorPixels(screenshot, [212, 59, 53])).toBeGreaterThan(0);
    expect(await countSolidColorPixels(screenshot, [55, 163, 107])).toBeGreaterThan(0);
    await page.close();
  });
  it("preserves decimal Toomics chapters and their thumbnail without the work ID", async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.setContent(`<ul style="margin:0;padding:0">
      <li class="eps__li" style="list-style:none;width:320px;height:140px">
        <a href="javascript:;" onclick="Base.popup('login', '/webtoon/episode/toon/6897', 'Y')" style="display:block;width:320px;height:140px">
          <img src="https://thumb.toomics.com/chapter-135.jpg" width="280" height="100">
          <div class="ep__episode">135</div>
          <div class="ep__title">마지막 장면</div>
        </a>
      </li>
      <li class="eps__li" style="list-style:none;width:320px;height:140px">
        <a href="javascript:;" onclick="Base.popup('login', '/webtoon/detail/code/234492/ep/135.5/toon/6897', 'Y')" style="display:block;width:320px;height:140px">
          <img src="https://thumb.toomics.com/afterword.jpg" width="280" height="100">
          <div class="ep__episode">후기</div>
          <div class="ep__title" lang="ko">끝나지 않은 이야기</div>
          <div class="ep__title" lang="en">An Unfinished Story</div>
        </a>
      </li>
    </ul>`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { document.documentElement.lang = "ko"; });

    const chapters = await findRenderedChapters(page, "toomics");
    expect(chapters.map((chapter) => chapter.number)).toContain("135");
    expect(chapters.map((chapter) => chapter.number)).toContain("135.5");
    expect(chapters.some((chapter) => chapter.number === "6897")).toBe(false);
    expect(chapters.find((chapter) => chapter.number === "135.5")?.thumbnailUrl).toContain("afterword.jpg");
    expect(chapters.find((chapter) => chapter.number === "135.5")?.subtitle).toBe("An Unfinished Story");
    expect(chapters.find((chapter) => chapter.number === "135.5")?.subtitleLanguage).toBe("en");
    expect(chapters.find((chapter) => chapter.number === "135.5")?.subtitleEn).toBe("An Unfinished Story");
    expect(chapters.find((chapter) => chapter.number === "135.5")?.subtitleKo).toBe("끝나지 않은 이야기");
    await page.close();
  });

  it("captures the full Toomics episode row instead of a short nested fragment", async () => {
    const page = await browser.newPage();
    const thumbnail = "https://thumb.toomics.com/chapter-135.jpg";
    await page.setContent(`<ul style="margin:0;padding:0">
      <li style="list-style:none;width:320px;height:160px">
        <a href="javascript:;" style="display:block;width:320px;height:160px">
          <div class="episode-fragment" style="width:320px;height:94px;overflow:hidden">
            <img src="${thumbnail}" width="96" height="72">
            <div class="ep__episode">135</div>
            <div class="ep__title">A chapter title</div>
          </div>
          <div class="episode-date" style="height:66px">26.10.24</div>
        </a>
      </li>
    </ul>`);

    const chapters = await findRenderedChapters(page, "toomics");
    const chapter = chapters.find((candidate) => candidate.number === "135");
    expect(chapter?.box.height).toBe(160);
    await page.close();
  });

  it("prefers the visible Toptoon chapter label over an internal episode ID", async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 800 });
    const thumbnail = svgDataUrl("#3b73d4");
    await page.setContent(`<ul style="margin:0;padding:0">
      <li style="list-style:none;width:320px;height:140px">
        <a href="/comic/ep/57" data-episode="57" style="display:block;width:320px;height:140px">
          <div class="flex-item thumb"><img src="${thumbnail}" width="96" height="72"></div>
          <div class="thumb_text"><p class="ep_title">23화</p><p class="ep_stitle">Sample subtitle</p><p>26.08.12</p></div>
        </a>
      </li>
    </ul>`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    });

    const chapters = await findRenderedChapters(page, "toptoon");
    expect(chapters.map(chapter => chapter.number)).toEqual(["23"]);
    await page.close();
  });

  it("splits ten Toomics chapter cards into two images of five", () => {
    const chapters = Array.from({ length: 10 }, (_, index) => ({
      number: String(index + 101),
      key: `chapter-${index + 101}`,
      parser: "Playwright browser",
      captureId: `toomics-${index + 101}`,
      captureOrder: index,
      thumbnailUrl: `https://thumb.toomics.com/${index + 101}.jpg`,
      box: { x: 0, y: index * 100, width: 640, height: 90 },
    })) as BrowserChapterSnapshot[];

    expect(makeGreedyGroups(chapters, 5).map(group => group.length)).toEqual([5, 5]);
    expect(makeGreedyGroups(chapters).map(group => group.length)).toEqual([10]);
    expect(capturedGroupWithinLimit("toomics", 5)).toBe(true);
    expect(capturedGroupWithinLimit("toomics", 13)).toBe(false);
    expect(capturedGroupWithinLimit("toptoon", 13)).toBe(true);
  });

  it("preserves the original Toomics title and writes the decimal episode number without translation", async () => {
    const page = await browser.newPage();
    await page.setContent(`<article data-monitor-capture-card="toomics-135-5">
      <div class="ep__episode">후기</div>
      <div class="ep__title">끝나지 않은 이야기</div>
    </article>`);

    await applyCaptureSubtitles(page, [{
      captureId: "toomics-135-5",
      chapterNumber: "135.5",
    }]);

    expect(await page.locator(".ep__episode").textContent()).toBe("135.5");
    expect(await page.locator(".ep__title").textContent()).toBe("끝나지 않은 이야기");
    await page.close();
  });

  it("promotes a selected data-original thumbnail over the currently rendered logo", async () => {
    const page = await browser.newPage();
    const logo = svgDataUrl("#d43b35");
    const artwork = svgDataUrl("#3b73d4");
    await page.setContent(`<article data-monitor-capture-card="toomics-14">
      <img src="${logo}" data-original="${artwork}" width="96" height="72">
    </article>`);
    await page.waitForFunction(() => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement && image.complete;
    });

    const targets: CaptureThumbnailTarget[] = [{
      captureId: "toomics-14",
      thumbnailUrl: artwork,
    }];
    await promotePrimaryThumbnails(page, targets);
    await page.waitForFunction((expected) => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.currentSrc === expected;
    }, artwork);

    expect(await page.locator("img").getAttribute("src")).toBe(artwork);
    const screenshot = await page.locator("article").screenshot();
    expect(await countSolidColorPixels(screenshot, [59, 115, 212])).toBeGreaterThan(100);
    expect(await countSolidColorPixels(screenshot, [212, 59, 53])).toBe(0);
    await page.close();
  });

  it("promotes the selected primary thumbnail for non-Toomics works", async () => {
    const page = await browser.newPage();
    const placeholder = svgDataUrl("#d43b35");
    const artwork = svgDataUrl("#3b73d4");
    await page.setContent(`<article data-monitor-capture-card="chapter-14">
      <img src="${placeholder}" data-src="${artwork}" width="96" height="72">
    </article>`);
    await page.waitForFunction(() => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement && image.complete;
    });

    await promotePrimaryThumbnails(page, [{
      captureId: "chapter-14",
      thumbnailUrl: artwork,
    }]);
    await page.waitForFunction((expected) => {
      const image = document.querySelector("img");
      return image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.currentSrc === expected;
    }, artwork);

    expect(await page.locator("img").getAttribute("src")).toBe(artwork);
    await page.close();
  });

  it("replaces the primary image with exactly two selected extra images on a test card", async () => {
    const page = await browser.newPage();
    const primary = svgDataUrl("#3b73d4");
    const second = svgDataUrl("#d43b35");
    const third = svgDataUrl("#37a36b");
    await page.setContent(`<article data-monitor-capture-card="chapter-36" style="display:flex;width:900px">
      <div class="flex-item thumb"><img src="${primary}" width="96" height="72"></div>
      <div class="thumb_text"><p class="ep_title">EP 36</p><p class="ep_stitle">Um encontro inesperado</p><p>26.10.05</p></div>
      </article>`);
    await applyToptoonPairCapture(page, [{ captureId: "chapter-36", urls: [second, third] }]);
    expect(await page.locator(".thumb img").count()).toBe(2);
    expect((await page.locator(".thumb img").first().boundingBox())?.height).toBe(138);
    expect((await page.locator("[data-monitor-capture-card]").boundingBox())?.height).toBe(162);
    expect(await page.locator("[data-monitor-extra-thumbnail='2']").getAttribute("src")).toBe(second);
    expect(await page.locator("[data-monitor-extra-thumbnail='3']").getAttribute("src")).toBe(third);
    const screenshot = await page.locator("article").screenshot();
    expect(await countSolidColorPixels(screenshot, [59, 115, 212])).toBe(0);
    expect(await countSolidColorPixels(screenshot, [212, 59, 53])).toBeGreaterThan(100);
    expect(await countSolidColorPixels(screenshot, [55, 163, 107])).toBeGreaterThan(100);
    expect(await page.locator(".ep_stitle").textContent()).toBe("Um encontro inesperado");
    await page.close();
  });

  it("places Portuguese text below the chapter number without changing thumbnail or date", async () => {
    const page = await browser.newPage();
    await page.setContent(`<article data-monitor-capture-card="chapter-36">
      <img src="${svgDataUrl("#213547")}" width="96" height="72">
      <div><p class="ep_title">Episode 36</p><p class="ep_stitle"></p><p class="ep_date">26.10.05</p></div>
      </article>`);
    const imageBefore = await page.locator("img").getAttribute("src");
    await applyCaptureSubtitles(page, [{
      captureId: "chapter-36", subtitlePt: "O que você está fazendo com Inha?",
    }]);
    expect(await page.locator(".ep_stitle").textContent()).toBe("O que você está fazendo com Inha?");
    expect(await page.locator(".ep_stitle").getAttribute("lang")).toBe("pt-BR");
    expect(await page.locator(".ep_date").textContent()).toBe("26.10.05");
    expect(await page.locator("img").getAttribute("src")).toBe(imageBefore);
    const title = await page.locator(".ep_title").boundingBox();
    const subtitle = await page.locator(".ep_stitle").boundingBox();
    const date = await page.locator(".ep_date").boundingBox();
    expect(subtitle!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
    expect(date!.y).toBeGreaterThanOrEqual(subtitle!.y + subtitle!.height);
    await page.close();
  });

  it("does not show untranslated text when the translation is unavailable", async () => {
    const page = await browser.newPage();
    await page.setContent(`<article data-monitor-capture-card="chapter-36">
      <p class="ep_title">Episode 36</p><p class="ep_stitle">원래 제목</p></article>`);
    await applyCaptureSubtitles(page, [{ captureId: "chapter-36" }]);
    expect(await page.locator(".ep_stitle").isVisible()).toBe(false);
    expect(await page.locator(".ep_title").textContent()).toBe("Episode 36");
    await page.close();
  });

  it("prefers the English title over Korean and Portuguese fallbacks", async () => {
    const page = await browser.newPage();
    await page.setContent(`<article data-monitor-capture-card="toomics-135">
      <div class="ep__episode">135</div>
      <div class="ep__title" lang="ko">마지막 장면</div>
      <div class="ep__title" lang="en">The Last Scene</div>
      <span class="ep__date">2026.10.08</span></article>`);
    await applyCaptureSubtitles(page, [{
      captureId: "toomics-135", subtitleEn: "The Last Scene",
      subtitleKo: "마지막 장면", subtitlePt: "A última cena",
    }]);
    expect(await page.locator(".ep__title[lang='en']").textContent()).toBe("The Last Scene");
    expect(await page.locator(".ep__title[lang='en']").getAttribute("lang")).toBe("en");
    expect(await page.locator(".ep__date").textContent()).toBe("2026.10.08");
    await page.close();
  });

  it("preserves the original Toomics title when translation is unavailable", async () => {
    const page = await browser.newPage();
    await page.setContent(`<article data-monitor-capture-card="toomics-135">
      <div class="ep__title">마지막 장면</div></article>`);
    await applyCaptureSubtitles(page, [{ captureId: "toomics-135" }]);
    expect(await page.locator(".ep__title").isVisible()).toBe(true);
    expect(await page.locator(".ep__title").textContent()).toBe("마지막 장면");
    await page.close();
  });

  it("keeps the selected thumbnail and removes sibling image panels", async () => {
    const page: Page = await browser.newPage();
    const primary = svgDataUrl("#d43b35");
    const extraOne = svgDataUrl("#3b73d4");
    const extraTwo = svgDataUrl("#37a36b");
    const extraThree = svgDataUrl("#d49c35");

    await page.setContent(`
      <style>
        #extra-background::before {
          content: "";
          display: block;
          width: 96px;
          height: 72px;
          background-image: url("${extraThree}");
        }
      </style>
      <article data-monitor-capture-card="chapter-1"
        style="display:flex;gap:8px;width:420px;height:120px;align-items:center">
        <div><img id="primary" width="96" height="72" src="${primary}"></div>
        <div><img id="extra-image-one" width="96" height="72" src="${extraOne}"></div>
        <div data-ep_thumb2="${extraTwo}"
          style="width:96px;height:72px;background-image:url('${extraTwo}')"></div>
        <div id="extra-background"></div>
        <span>Chapter 14</span>
      </article>
    `);
    await page.waitForFunction(() =>
      Array.from(document.images).every((image) => image.complete),
    );

    const targets: CaptureThumbnailTarget[] = [{
      captureId: "chapter-1",
      thumbnailUrl: primary,
    }];
    await isolatePrimaryThumbnails(page, targets);

    const result = await page.locator('[data-monitor-capture-card="chapter-1"]')
      .evaluate((card) => {
        const visibleImages = Array.from(card.querySelectorAll("img"))
          .filter((image) => {
            const style = getComputedStyle(image);
            return style.display !== "none" && style.visibility !== "hidden";
          })
          .map((image) => image.currentSrc);
        const renderedBackgrounds = [
          card,
          ...Array.from(card.querySelectorAll("*")),
        ].flatMap((node) => {
          const element = node as HTMLElement;
          return [
            getComputedStyle(element).backgroundImage,
            getComputedStyle(element, "::before").backgroundImage,
            getComputedStyle(element, "::after").backgroundImage,
          ].filter((value) => value !== "none" && value.includes("url("));
        });
        return {
          visibleImages,
          renderedBackgrounds,
          text: card.textContent,
        };
      });

    expect(result.visibleImages).toEqual([primary]);
    expect(result.renderedBackgrounds).toEqual([]);
    expect(result.text).toContain("Chapter 14");

    const screenshot = await page.screenshot({ type: "png" });
    expect(await countSolidColorPixels(screenshot, [212, 59, 53])).toBeGreaterThan(100);
    expect(await countSolidColorPixels(screenshot, [59, 115, 212])).toBe(0);
    expect(await countSolidColorPixels(screenshot, [55, 163, 107])).toBe(0);
    expect(await countSolidColorPixels(screenshot, [212, 156, 53])).toBe(0);
    await page.close();
  });
});