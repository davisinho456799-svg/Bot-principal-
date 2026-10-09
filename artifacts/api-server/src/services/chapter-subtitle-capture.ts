/// <reference lib="dom" />
import type { Page } from "playwright";

export type CaptureSubtitle = { captureId: string; subtitlePt?: string };

/** Keep the source card; replace only its subtitle before taking the screenshot. */
export async function applyCaptureSubtitles(page: Page, subtitles: CaptureSubtitle[]): Promise<void> {
  if (!subtitles.length) return;
  await page.evaluate((items) => {
    for (const item of items) {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-monitor-capture-card]"))
        .find(node => node.getAttribute("data-monitor-capture-card") === item.captureId);
      if (!card) continue;
      let subtitle = card.querySelector<HTMLElement>(".ep_stitle,.episode-subtitle,.chapter-subtitle,[data-chapter-subtitle]");
      if (!item.subtitlePt) {
        if (subtitle) subtitle.style.setProperty("display", "none", "important");
        continue;
      }
      if (!subtitle) {
        const title = card.querySelector<HTMLElement>(".ep_title,.episode-title,.chapter-title,.tit_area");
        if (!title) throw new Error("Chapter title anchor not found for translated subtitle");
        subtitle = document.createElement("p");
        title.insertAdjacentElement("afterend", subtitle);
      }
      subtitle.textContent = item.subtitlePt;
      subtitle.setAttribute("data-monitor-translated-subtitle", "pt-BR");
      subtitle.setAttribute("lang", "pt-BR");
      subtitle.style.setProperty("display", "block", "important");
      subtitle.style.setProperty("white-space", "normal", "important");
      subtitle.style.setProperty("overflow-wrap", "anywhere", "important");
      subtitle.style.setProperty("overflow", "visible", "important");
      subtitle.style.setProperty("height", "auto", "important");
      subtitle.style.setProperty("max-height", "none", "important");
      subtitle.style.setProperty("-webkit-line-clamp", "unset", "important");
      subtitle.style.setProperty("margin", "6px 0", "important");
    }
  }, subtitles);
}