/** Hourly image checks follow clock boundaries, not the previous run's minute. */
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
  if (intervalMinutes === 60) {
    // Brasília uses a whole-hour UTC offset, so these are also its full hours.
    // A saved check in this hour satisfies its slot, including a manual check.
    // If the process missed a slot, catch up once without moving later slots.
    const hourStart = Math.floor(now / intervalMs) * intervalMs;
    if (checkedAt < hourStart) return 0;
    return hourStart + intervalMs - now;
  }
  // Preserve existing behavior for other explicitly configured intervals.
  return Math.max(0, checkedAt + intervalMs - now);
}