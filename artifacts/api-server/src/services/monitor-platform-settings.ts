import type { MonitorPlatform } from "./parsers/index";

// Toomics requests are paused at the user's request until they ask to resume.
const PAUSED_MONITOR_PLATFORMS = new Set<MonitorPlatform>(["toomics"]);

export function isMonitorPlatformEnabled(platform: MonitorPlatform): boolean {
  return !PAUSED_MONITOR_PLATFORMS.has(platform);
}

export function assertMonitorPlatformEnabled(platform: MonitorPlatform): void {
  if (!isMonitorPlatformEnabled(platform)) {
    throw new Error("O monitor do Toomics está pausado temporariamente; nenhuma consulta foi feita.");
  }
}
