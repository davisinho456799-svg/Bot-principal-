import type { CalendarEntry } from "./calendar-data.js";
import type { CalendarPeriod, CalendarTab } from "./calendar-panel.js";

interface CalendarSnapshot {
  userId: string;
  adult: boolean;
  tab: CalendarTab;
  period: CalendarPeriod;
  entries: CalendarEntry[];
  expiresAt: number;
}

// Only private result messages have sessions. Public panels remain stateless
// and can always open a fresh consultation, including after a restart.
const snapshots = new Map<string, CalendarSnapshot>();
const LIFETIME_MS = 30 * 60_000;
const MAX_SNAPSHOTS = 100;

export function saveCalendarSnapshot(
  messageId: string, snapshot: Omit<CalendarSnapshot, "expiresAt">,
) {
  const now = Date.now();
  for (const [id, value] of snapshots) {
    if (value.expiresAt <= now) snapshots.delete(id);
  }
  snapshots.delete(messageId);
  while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(messageId, { ...snapshot, expiresAt: now + LIFETIME_MS });
}

export function getCalendarSnapshot(
  messageId: string, userId: string,
  state: Pick<CalendarSnapshot, "adult" | "tab" | "period">,
): CalendarEntry[] | null {
  const snapshot = snapshots.get(messageId);
  if (!snapshot) return null;
  if (snapshot.expiresAt <= Date.now()) {
    snapshots.delete(messageId);
    return null;
  }
  if (snapshot.userId !== userId || snapshot.adult !== state.adult ||
      snapshot.tab !== state.tab || snapshot.period !== state.period) return null;
  return snapshot.entries;
}
