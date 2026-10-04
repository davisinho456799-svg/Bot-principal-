export const RELEASE_BANNER_HEIGHT = 92;

const xml = (text: string) => text.replace(/[<>&'"]/g, character =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]!);

export function buildReleaseBannerMarkup(title: string, chapterCount: number): string {
  return `<text x="34" y="44" fill="#132b3f" font-family="Arial,sans-serif" font-size="25" font-weight="700">${xml(title)}</text><text x="34" y="70" fill="#d8624c" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">NEW CHAPTERS · ${chapterCount}</text>`;
}

export function buildReleaseBannerSvg(width: number, title: string, chapterCount: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${RELEASE_BANNER_HEIGHT}" viewBox="0 0 ${width} ${RELEASE_BANNER_HEIGHT}"><rect width="100%" height="100%" fill="#fffaf3"/>${buildReleaseBannerMarkup(title, chapterCount)}</svg>`;
}