import type { ParsedChapter } from "./parsers/parser-types";

const escapeXml = (value: string) => value.replace(/[<>&"']/g, c =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function subtitleLines(text: string, limit = 46): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    for (const piece of word.match(new RegExp(`.{1,${limit}}`, "gu")) ?? []) {
      if (line && [...`${line} ${piece}`].length > limit) {
        lines.push(line);
        line = "";
      }
      line = line ? `${line} ${piece}` : piece;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function buildSubtitleRowsLayout(chapters: ParsedChapter[], headerHeight: number, rowHeight: number) {
  let y = headerHeight;
  const rows = chapters.map(chapter => {
    const lines = chapter.subtitlePt ? subtitleLines(chapter.subtitlePt).length : 0;
    const height = Math.max(rowHeight, (chapter.releaseDate ? 124 : 100) + lines * 26);
    const row = { y, height };
    y += height;
    return row;
  });
  return { rows, height: y + 24 };
}

export function buildSubtitleFallbackRow(chapter: ParsedChapter, y: number, height: number, hasThumbnail: boolean) {
  const lines = subtitleLines(chapter.subtitlePt ?? "");
  return `<rect x="24" y="${y}" width="872" height="${height - 24}" rx="14" fill="#f5f0e8" stroke="#ded5c8"/>
    ${hasThumbnail ? "" : `<text x="52" y="${y + 70}" fill="#7a746c" font-family="Arial,sans-serif" font-size="18">Imagem indisponível</text>`}
    <text x="308" y="${y + 42}" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">${escapeXml(chapter.number)}</text>
    ${lines.map((line, i) => `<text x="308" y="${y + 72 + i * 26}" fill="#625d56" font-family="Arial,sans-serif" font-size="22">${escapeXml(line)}</text>`).join("")}
    ${chapter.releaseDate ? `<text x="308" y="${y + 94 + lines.length * 26}" fill="#7a746c" font-family="Arial,sans-serif" font-size="16">${escapeXml(chapter.releaseDate)}</text>` : ""}`;
}