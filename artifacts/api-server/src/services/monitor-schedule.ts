/** Use persisted checks so restarting the process does not reset the interval. */
export function getMonitorDelayMs(
  lastCheckedAt: Date | string | null,
  intervalMinutes: number,
  now = Date.now(),
): number {
  const intervalMs = intervalMinutes * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMinutes < 5) {
    throw new Error("Invalid image monitor interval");
  }
  if (lastCheckedAt === null) return 0;
  const checkedAt = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return 0;
  // Rechecking a future timestamp hourly would otherwise defer forever.
  if (checkedAt > now) return 0;
  return Math.max(0, checkedAt + intervalMs - now);
}