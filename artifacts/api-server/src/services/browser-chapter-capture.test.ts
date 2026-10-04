import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { applyCaptureSubtitles } from "./chapter-subtitle-capture";
import { applyToptoonPairCapture } from "./toptoon-pair-capture";
import {
  isolatePrimaryThumbnails,
  type CaptureThumbnailTarget,
} from "./browser-chapter-capture";

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