export const RELEASE_BANNER_HEIGHT = 92;
export type ReleaseBannerTheme = "light" | "dark";

const xml = (text: string) => text.replace(/[<>&'"]/g, character =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]!);

export function buildReleaseBannerMarkup(
  title: string,
  chapterNumbers: readonly string[],
  theme: ReleaseBannerTheme = "light",
): string {
  const titleColor = theme === "dark" ? "#f2f3f5" : "#132b3f";
  const chapterLabel = chapterNumbers.length
    ? ` · CAP. ${chapterNumbers.map(xml).join(", ")}`
    : "";
  return `<text x="34" y="44" fill="${titleColor}" font-family="Arial,sans-serif" font-size="25" font-weight="700">${xml(title)}</text><text x="34" y="70" fill="#d8624c" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">NEW CHAPTERS · ${chapterNumbers.length}${chapterLabel}</text>`;
}

export function buildReleaseBannerSvg(
  width: number,
  title: string,
  chapterNumbers: readonly string[],
  theme: ReleaseBannerTheme = "light",
): string {
  const background = theme === "dark" ? "#202122" : "#fffaf3";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${RELEASE_BANNER_HEIGHT}" viewBox="0 0 ${width} ${RELEASE_BANNER_HEIGHT}"><rect width="100%" height="100%" fill="${background}"/>${buildReleaseBannerMarkup(title, chapterNumbers, theme)}</svg>`;
}