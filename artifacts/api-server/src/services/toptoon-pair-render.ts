import type { ParsedChapter } from "./parsers/parser-types";
import { subtitleLines } from "./chapter-subtitle-render";

const xml = (text: string) => text.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Same two portrait panels for browser-less tests; no primary image is accepted. */
export async function renderToptoonPairCard(chapter: ParsedChapter, images: [Buffer, Buffer]): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const lines = subtitleLines(chapter.subtitlePt ?? "", 40);
  const height = Math.max(310, 160 + lines.length * 29);
  const text = `<svg width="1024" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#202122"/>
    <text x="474" y="121" fill="#ffffff" font-family="Arial,sans-serif" font-size="26" font-weight="700">${xml(chapter.number)}</text>
    ${lines.map((line, i) => `<text x="474" y="${154 + i * 29}" fill="#b5b5b5" font-family="Arial,sans-serif" font-size="23">${xml(line)}</text>`).join("")}
    ${chapter.releaseDate ? `<text x="474" y="${178 + lines.length * 29}" fill="#858585" font-family="Arial,sans-serif" font-size="18">${xml(chapter.releaseDate)}</text>` : ""}
    </svg>`;
  const inputs = await Promise.all(images.map(image => sharp(image).resize(208, 288, { fit: "contain", background: "#202122" }).png().toBuffer()));
  return sharp(Buffer.from(text)).composite(inputs.map((input, index) => ({
    input, left: index === 0 ? 16 : 234, top: 13,
  }))).png().toBuffer();
}