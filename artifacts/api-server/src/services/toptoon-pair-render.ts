import type { ParsedChapter } from "./parsers/parser-types";
import { subtitleLines } from "./chapter-subtitle-render";
import { TOPTOON_PAIR_LAYOUT } from "./toptoon-pair-layout";

const xml = (text: string) => text.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Same two portrait panels for browser-less tests; no primary image is accepted. */
export async function renderToptoonPairCard(chapter: ParsedChapter, images: [Buffer, Buffer]): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { panelWidth, panelHeight, gap, padding, minCardHeight } = TOPTOON_PAIR_LAYOUT;
  const textX = padding + panelWidth * 2 + gap + 16;
  const lines = subtitleLines(chapter.subtitlePt ?? "", 60);
  const height = Math.max(minCardHeight, (chapter.releaseDate ? 110 : 86) + lines.length * 26);
  const text = `<svg width="1024" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#202122"/>
    <text x="${textX}" y="42" fill="#ffffff" font-family="Arial,sans-serif" font-size="26" font-weight="700">${xml(chapter.number)}</text>
    ${lines.map((line, i) => `<text x="${textX}" y="${74 + i * 26}" fill="#b5b5b5" font-family="Arial,sans-serif" font-size="23">${xml(line)}</text>`).join("")}
    ${chapter.releaseDate ? `<text x="${textX}" y="${98 + lines.length * 26}" fill="#858585" font-family="Arial,sans-serif" font-size="18">${xml(chapter.releaseDate)}</text>` : ""}
    </svg>`;
  const inputs = await Promise.all(images.map(image => sharp(image).resize(panelWidth, panelHeight, { fit: "contain", background: "#202122" }).png().toBuffer()));
  return sharp(Buffer.from(text)).composite(inputs.map((input, index) => ({
    input, left: padding + index * (panelWidth + gap), top: padding,
  }))).png().toBuffer();
}