export const MIN_CALENDAR_ANIME_MINUTES = 10;
export const CALENDAR_ANIME_DURATION_NOTICE =
  "Filtro: episódios com duração conhecida abaixo de 10 minutos ficam fora. Duração não informada é mantida.";

/** AniList reports minutes; MAL/Tenrai reports durations with explicit units. */
export function calendarAnimeDurationMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+per\s+ep(?:isode)?\.?$/i, "").trim();
  const match = /^(?:(\d+(?:\.\d+)?)\s*(?:hours?|hr|h)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:minutes?|min|m)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:seconds?|sec|s)\s*)?$/i.exec(text);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) + Number(match[3] ?? 0) / 60;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** Unknown duration cannot safely establish that a work is shorter than the cutoff. */
export function isCalendarAnimeDurationAllowed(value: unknown): boolean {
  const minutes = calendarAnimeDurationMinutes(value);
  return minutes === null || minutes >= MIN_CALENDAR_ANIME_MINUTES;
}
