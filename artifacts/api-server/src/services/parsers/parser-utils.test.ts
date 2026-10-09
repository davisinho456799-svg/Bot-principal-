import { describe, expect, it } from "vitest";
import { parsePlatformChapterHtml } from "./parser-utils";

describe("platform chapter thumbnail parsing", () => {
  it("prefers Toomics lazy artwork over the current logo src", () => {
    const html = `<a href="/toon/your-mom-is-the-best/episode">
      <span>Episode 14</span>
      <img src="/images/toomics-logo.png" data-original="/uploads/chapter-14.jpg">
    </a>`;

    expect(
      parsePlatformChapterHtml(
        html,
        "https://global.toomics.com/webtoon/your-mom-is-the-best",
        "toomics",
      ),
    ).toEqual([{
      number: "14",
      thumbnailUrl: "https://global.toomics.com/uploads/chapter-14.jpg",
    }]);
  });
});
