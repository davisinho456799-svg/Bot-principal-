/// <reference lib="dom" />
import type { Page } from "playwright";

export type CaptureSubtitle = {
  captureId: string;
  chapterNumber?: string;
  subtitleEn?: string;
  subtitleKo?: string;
  subtitlePt?: string;
};

/** Keep the source card; replace only its subtitle before taking the screenshot. */
export async function applyCaptureSubtitles(page: Page, subtitles: CaptureSubtitle[]): Promise<void> {
  if (!subtitles.length) return;
  await page.evaluate((items) => {
    for (const item of items) {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-monitor-capture-card]"))
        .find(node => node.getAttribute("data-monitor-capture-card") === item.captureId);
      if (!card) continue;
      let subtitle = card.querySelector<HTMLElement>(".ep_stitle,.episode-subtitle,.chapter-subtitle,[data-chapter-subtitle]");
      const title = card.querySelector<HTMLElement>(".ep__title,.ep_title,.episode-title,.chapter-title,.tit_area");
      if (item.chapterNumber) {
        const episode = card.querySelector<HTMLElement>(".ep__episode");
        if (episode) episode.textContent = item.chapterNumber;
      }
      const displayTitle = item.subtitleEn ?? item.subtitleKo ?? item.subtitlePt;
      const displayLanguage = item.subtitleEn ? "en" : item.subtitleKo ? "ko" : "pt-BR";
      if (!displayTitle && subtitle && !item.chapterNumber) {
        subtitle.style.setProperty("display", "none", "important");
      }
      if (!displayTitle) continue;
      const languageTarget = item.subtitleEn
        ? card.querySelector<HTMLElement>('[lang|="en"],[data-lang="en"],[data-subtitle-en],[data-title-en],[data-ep-title-en],.ep__title--en,.ep_stitle--en')
        : item.subtitleKo
          ? card.querySelector<HTMLElement>('[lang|="ko"],[data-lang="ko"],[data-subtitle-ko],[data-title-ko],[data-ep-title-ko],.ep__title--ko,.ep_stitle--ko')
          : null;
      let target = languageTarget ?? subtitle ?? title;
      if (!target) {
        if (!item.chapterNumber) throw new Error("Chapter title anchor not found for translated subtitle");
        target = document.createElement("p");
        card.append(target);
      }
      target.textContent = displayTitle;
      target.setAttribute("lang", displayLanguage);
      if (displayLanguage === "pt-BR") target.setAttribute("data-monitor-translated-subtitle", "pt-BR");
      target.style.setProperty("display", "block", "important");
      target.style.setProperty("white-space", "normal", "important");
      target.style.setProperty("overflow-wrap", "anywhere", "important");
      target.style.setProperty("overflow", "visible", "important");
      target.style.setProperty("height", "auto", "important");
      target.style.setProperty("max-height", "none", "important");
      target.style.setProperty("-webkit-line-clamp", "unset", "important");
      target.style.setProperty("margin", "6px 0", "important");
    }
  }, subtitles);
}