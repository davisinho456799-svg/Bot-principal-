import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
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

describe("single-thumbnail chapter capture", () => {
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
    await page.close();
  });
});