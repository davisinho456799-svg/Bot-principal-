import { logger } from "../lib/logger";
import { cleanChapterSubtitle } from "./parsers/chapter-subtitles";
import type { ParsedChapter } from "./parsers/parser-types";

function sourceLanguage(text: string, hint?: string): string | undefined {
  if (/[가-힣]/u.test(text)) return "ko";
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  const language = hint?.toLowerCase().split("-")[0];
  return language && /^[a-z]{2}$/.test(language) ? language : "en";
}

/**
 * A name followed by Korean "oppa" is a form of address, not "X's brother".
 * Keep the translated name; do not invent a sibling relationship. The
 * possessive form (e.g. X의 오빠) intentionally does not match this rule.
 */
export function normalizeSubtitleHonorifics(original: string, translated: string): string {
  if (!/(?:^|[^가-힣])[가-힣]{2,4}(?<!의)\s+오빠/u.test(original)) return translated;
  return translated.replace(
    /\birmão (?:mais velho )?de (\p{Lu}[\p{L}.-]*(?:\s+\p{Lu}[\p{L}.-]*)?)/gu,
    "$1",
  );
}

/** Public MyMemory API; no key required. Translation is optional, never a launch dependency. */
export function createSubtitleTranslator({
  request = fetch, now = Date.now, timeoutMs = 2_500,
  onFailure = (reason: string) => logger.warn({ reason }, "Subtítulo sem tradução; notificação preservada"),
} = {}) {
  const cache = new Map<string, { text?: string; expires: number }>();
  const pending = new Map<string, Promise<string | undefined>>();
  let cooldownUntil = 0;
  return async (original: string, languageHint?: string): Promise<string | undefined> => {
    const subtitle = cleanChapterSubtitle(original);
    if (!subtitle) return undefined;
    const language = sourceLanguage(subtitle, languageHint);
    if (language === "pt") return subtitle;
    // MyMemory's documented per-query limit is 500 UTF-8 bytes.
    if (Buffer.byteLength(subtitle, "utf8") > 500) {
      onFailure("SUBTITLE_TOO_LONG");
      return undefined;
    }
    const key = `${language}:${subtitle}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.text;
    if (pending.has(key)) return pending.get(key);
    if (now() < cooldownUntil) return undefined;
    const operation = (async () => {
      let translated: string | undefined;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const url = new URL("https://api.mymemory.translated.net/get");
        url.searchParams.set("q", subtitle);
        url.searchParams.set("langpair", `${language}|pt-BR`);
        const fetchTranslation = async () => {
          const response = await request(url.toString(), { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
          const body = await response.json();
          if (Number(body.responseStatus) !== 200 || body.quotaFinished === true) {
            throw new Error(body.quotaFinished ? "TRANSLATION_QUOTA" : "INVALID_TRANSLATION");
          }
          const result = cleanChapterSubtitle(body.responseData?.translatedText);
          if (!result || result.toLocaleLowerCase() === subtitle.toLocaleLowerCase() ||
              /[가-힣\u3040-\u30ff\u3400-\u9fff]/u.test(result)) {
            throw new Error("UNTRANSLATED_SUBTITLE");
          }
          return normalizeSubtitleHonorifics(subtitle, result);
        };
        translated = await Promise.race([
          fetchTranslation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("TRANSLATION_TIMEOUT"));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "TRANSLATION_FAILED";
        cooldownUntil = now() + (reason === "TRANSLATION_QUOTA" ? 24 * 60 * 60_000 : 60_000);
        onFailure(reason);
      } finally {
        if (timer) clearTimeout(timer);
        pending.delete(key);
      }
      cache.delete(key);
      cache.set(key, { text: translated, expires: now() + (translated ? 7 * 24 * 60 * 60_000 : 60_000) });
      while (cache.size > 512) cache.delete(cache.keys().next().value!);
      return translated;
    })();
    pending.set(key, operation);
    return operation;
  };
}

const translateSubtitle = createSubtitleTranslator();

export async function translateChapterSubtitles(
  chapters: ParsedChapter[], translate = translateSubtitle,
): Promise<void> {
  // Sequential requests respect the free service budget. Only outgoing chapters
  // reach this function, never the initial baseline or the whole saved history.
  for (const chapter of chapters) {
    if (chapter.subtitle) chapter.subtitlePt = await translate(chapter.subtitle, chapter.subtitleLanguage);
  }
}