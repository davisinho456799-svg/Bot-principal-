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

  it("preserves decimal Toomics chapters from their route without using the work ID", () => {
    const html = `<a href="javascript:;" onclick="Base.popup('login', '/webtoon/episode/toon/6897', 'Y')">
      <div class="ep__episode">135</div>
      <img src="/images/toomics-logo.png" data-original="/uploads/chapter-135.jpg">
    </a>
    <a href="javascript:;" onclick="Base.popup('login', '/webtoon/detail/code/234492/ep/135.5/toon/6897', 'Y')">
      <div class="ep__episode">후기</div>
      <img src="/images/toomics-logo.png" data-original="/uploads/afterword.jpg">
    </a>`;

    expect(
      parsePlatformChapterHtml(
        html,
        "https://www.toomics.com/uplmscg/episode/toon/6897",
        "toomics",
      ),
    ).toEqual([{
      number: "135",
      thumbnailUrl: "https://www.toomics.com/uploads/chapter-135.jpg",
    }, {
      number: "135.5",
      thumbnailUrl: "https://www.toomics.com/uploads/afterword.jpg",
    }]);
  });
});
