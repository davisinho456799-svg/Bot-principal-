import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichChapterSubtitles } from "./parsers/chapter-subtitles";
import { parsePlatformChapterHtml } from "./parsers/parser-utils";
import { createSubtitleTranslator, normalizeSubtitleHonorifics, translateChapterSubtitles } from "./chapter-subtitle-translation";
import { buildSubtitleFallbackRow, buildSubtitleRowsLayout, subtitleLines } from "./chapter-subtitle-render";
import type { ParsedChapter } from "./parsers/parser-types";

const url = "https://toptoon.com/comic/ep_list/Love_Quest";
const chapter: ParsedChapter = { number: "36", thumbnailUrl: "https://example.test/36.jpg" };
const metadata = (id: string, number: string, subtitle: string) => ({
  id, lastUpdated: { episodeId: number, episodeSubTitle: subtitle },
});
const html = (rows: unknown[]) => `<html lang="ko"><script>const x = {jsonData: ${JSON.stringify({ adult: rows })}};</script></html>`;
const success = (text = "O que você está fazendo com Inha?") => new Response(JSON.stringify({
  responseStatus: 200, quotaFinished: false, responseData: { translatedText: text },
}));
afterEach(() => vi.useRealTimers());

describe("optional source subtitles", () => {
  it("keeps extra image URLs separate from the primary and scoped to the exact work", () => {
    const card = (id: string) => `<a class="episode-items" data-comic-id="${id}"
      data-ep_thumb2="https://smurfs.toptoon.com/ep_thumb2/36.jpg"
      data-ep_thumb3="https://smurfs.toptoon.com/ep_thumb3/36.jpg">
      <p class="ep_title">제36화</p></a>`;
    const result = enrichChapterSubtitles(card("Love_Quest"), url, "toptoon", [chapter])[0];
    expect(result.thumbnailUrl).toBe(chapter.thumbnailUrl);
    expect(result.extraThumbnailUrls).toEqual([
      "https://smurfs.toptoon.com/ep_thumb2/36.jpg", "https://smurfs.toptoon.com/ep_thumb3/36.jpg",
    ]);
    expect(enrichChapterSubtitles(card("Other_Work"), url, "toptoon", [chapter])[0].extraThumbnailUrls).toBeUndefined();
    expect(enrichChapterSubtitles(card("Love_Quest").replace("https://smurfs.toptoon.com/ep_thumb3/36.jpg", "http://localhost/internal"), url, "toptoon", [chapter])[0].extraThumbnailUrls).toBeUndefined();
  });

  it("uses only the matching work and matching chapter", () => {
    const result = enrichChapterSubtitles(html([
      metadata("Other_Work", "36", "WRONG"),
      metadata("Love_Quest", "36", "인하 오빠랑 뭐하고 있는데..?"),
    ]), url, "toptoon", [{ ...chapter, number: "35" }, chapter]);
    expect(result[0].subtitle).toBeUndefined();
    expect(result[1].subtitle).toBe("인하 오빠랑 뭐하고 있는데..?");
    expect(result[1].subtitleLanguage).toBe("ko");
  });
  it("handles quoted braces without executing any source script", () => {
    const source = html([metadata("Love_Quest", "36", 'A "title" {with braces}')]);
    expect(enrichChapterSubtitles(source, url, "toptoon", [chapter])[0].subtitle).toBe('A "title" {with braces}');
  });
  it("ignores malformed data, missing titles and number-only placeholders", () => {
    for (const source of ["<script>jsonData: {not json}</script>", html([
      metadata("Love_Quest", "36", "제36화"),
    ])]) expect(enrichChapterSubtitles(source, url, "toptoon", [chapter])[0].subtitle).toBeUndefined();
  });
  it("extracts a visible subtitle on the source card without confusing the thumbnail or number", () => {
    const source = `<a class="episode-items" data-episode-id="36" data-ep_thumb1="/36.jpg">
      <p class="ep_title">제36화</p><p class="ep_stitle">A &amp; B</p></a>`;
    const result = parsePlatformChapterHtml(source, url, "toptoon");
    expect(result).toEqual([{ number: "36", thumbnailUrl: "https://toptoon.com/36.jpg", subtitle: "A & B", subtitleLanguage: undefined }]);
  });
  it("does not use Toptoon recommendation metadata for other platforms", () => {
    expect(enrichChapterSubtitles(html([metadata("Love_Quest", "36", "WRONG")]), url, "lezhin", [chapter])[0].subtitle).toBeUndefined();
  });
});

describe("bounded Portuguese subtitle translation", () => {
  it("keeps a named Korean form of address from becoming someone else's brother", () => {
    expect(normalizeSubtitleHonorifics("인하 오빠랑 뭐하고 있는데..?", "O que está fazendo com o irmão de Inha...?"))
      .toBe("O que está fazendo com o Inha...?");
    expect(normalizeSubtitleHonorifics("인하의 오빠", "O irmão de Inha"))
      .toBe("O irmão de Inha");
  });

  it("translates the real subtitle to pt-BR and reuses its cached result", async () => {
    const request = vi.fn<typeof fetch>(async () => success());
    const translate = createSubtitleTranslator({ request });
    expect(await translate("인하 오빠랑 뭐하고 있는데..?")).toBe("O que você está fazendo com Inha?");
    await translate("인하 오빠랑 뭐하고 있는데..?");
    expect(request).toHaveBeenCalledTimes(1);
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get("langpair")).toBe("ko|pt-BR");
  });
  it("shares in-flight work and does not call a provider for Portuguese text", async () => {
    const request = vi.fn<typeof fetch>(async () => success());
    const translate = createSubtitleTranslator({ request });
    await Promise.all([translate("안녕하세요"), translate("안녕하세요")]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await translate("Uma visita inesperada", "pt-BR")).toBe("Uma visita inesperada");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("stops a hanging provider and continues without the optional caption", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const onFailure = vi.fn();
    const translate = createSubtitleTranslator({ request, onFailure });
    const pending = translate("안녕하세요");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await pending).toBeUndefined();
    expect((request.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledWith("TRANSLATION_TIMEOUT");
  });
  it("backs off when quota is exhausted and refuses untranslated output", async () => {
    const onFailure = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      responseStatus: 403, quotaFinished: true,
    })));
    const translate = createSubtitleTranslator({ request, onFailure });
    expect(await translate("안녕하세요")).toBeUndefined();
    expect(await translate("다른 제목")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("TRANSLATION_QUOTA");
    const untranslated = createSubtitleTranslator({ request: vi.fn(async () => success("안녕하세요")), onFailure });
    expect(await untranslated("안녕하세요")).toBeUndefined();
  });
  it("translates only provided outgoing chapters with actual subtitles", async () => {
    const translate = vi.fn(async () => "Uma visita inesperada");
    const rows: ParsedChapter[] = [{ ...chapter }, { ...chapter, number: "37", subtitle: "An unexpected visit" }];
    await translateChapterSubtitles(rows, translate);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(rows[0].subtitlePt).toBeUndefined();
    expect(rows[1].subtitlePt).toBe("Uma visita inesperada");
  });
});

describe("subtitle fallback layout", () => {
  it("wraps long subtitles and keeps subsequent chapter rows separate", () => {
    const rows = [{ ...chapter, subtitlePt: "Uma visita inesperada e uma conversa muito importante ".repeat(5), releaseDate: "2026-10-05" }, chapter];
    const layout = buildSubtitleRowsLayout(rows, 92, 164);
    expect(layout.rows[0].height).toBeGreaterThan(164);
    expect(layout.rows[1].y).toBe(92 + layout.rows[0].height);
    expect(subtitleLines("a".repeat(120)).every(line => line.length <= 46)).toBe(true);
  });
  it("places the subtitle under the episode number and escapes XML", () => {
    const markup = buildSubtitleFallbackRow({ ...chapter, subtitlePt: 'A < B & "C"' }, 92, 164, true);
    expect(markup).toContain(">36</text>");
    expect(markup).not.toContain(">EP ");
    expect(markup).toContain("A &lt; B &amp; &quot;C&quot;");
    expect(markup).toContain('y="164"');
  });
});