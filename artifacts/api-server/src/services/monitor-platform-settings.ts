import type { MonitorPlatform } from "./parsers/index";

// Add a platform here only when its monitor should be temporarily paused.
const PAUSED_MONITOR_PLATFORMS = new Set<MonitorPlatform>();

export function isMonitorPlatformEnabled(platform: MonitorPlatform): boolean {
  return !PAUSED_MONITOR_PLATFORMS.has(platform);
}

export function assertMonitorPlatformEnabled(platform: MonitorPlatform): void {
  if (!isMonitorPlatformEnabled(platform)) {
    throw new Error("O monitor do Toomics está pausado temporariamente; nenhuma consulta foi feita.");
  }
}
