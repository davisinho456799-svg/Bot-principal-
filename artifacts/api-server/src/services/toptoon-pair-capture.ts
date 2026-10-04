/// <reference lib="dom" />
import type { Page } from "playwright";

/** Temporary DOM changes on the test page only; never changes source or normal rounds. */
export async function applyToptoonPairCapture(
  page: Page, pairs: Array<{ captureId: string; urls: [string, string] }>,
): Promise<void> {
  await page.evaluate(async items => {
    for (const { captureId, urls } of items) {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-monitor-capture-card]"))
        .find(node => node.getAttribute("data-monitor-capture-card") === captureId);
      if (!card) throw new Error("Toptoon test card not found");
      const container = card.querySelector<HTMLElement>(".flex-item.thumb");
      if (!container) throw new Error("Toptoon thumbnail container not found");
      // Remove the primary panel, rather than merely adding two more panels.
      container.replaceChildren();
      container.style.cssText = "display:flex!important;gap:12px!important;width:428px!important;flex:0 0 428px!important;height:288px!important;min-height:288px!important;overflow:visible!important";
      const images = urls.map((url, index) => {
        const image = document.createElement("img");
        image.src = url;
        image.alt = `Miniatura ${index + 2}`;
        image.setAttribute("data-monitor-extra-thumbnail", String(index + 2));
        image.style.cssText = "display:block!important;width:208px!important;height:288px!important;max-width:none!important;object-fit:contain!important;border-radius:10px";
        container.append(image);
        return image;
      });
      await Promise.all(images.map(image => image.decode()));
      for (const image of Array.from(card.querySelectorAll<HTMLImageElement>("img"))) {
        if (!container.contains(image) && /\/ep_thumb[123]\//.test(image.currentSrc || image.src)) {
          image.style.setProperty("display", "none", "important");
        }
      }
      card.style.setProperty("height", "auto", "important");
      card.style.setProperty("min-height", "310px", "important");
      card.style.setProperty("overflow", "visible", "important");
      const text = card.querySelector<HTMLElement>(".thumb_text");
      if (text) {
        text.style.setProperty("width", "auto", "important");
        text.style.setProperty("min-width", "0", "important");
        text.style.setProperty("flex", "1", "important");
      }
    }
  }, pairs);
}