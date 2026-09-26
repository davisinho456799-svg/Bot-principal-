// O monitor de imagem usa uma captura mais pesada (Playwright/Sharp), então
// sua frequência padrão é menor que a do monitor de embeds.
export const DEFAULT_MONITOR_INTERVAL_MINUTES = 7 * 60;

export function getMonitorIntervalMinutes(configuredInterval: number | null | undefined): number {
  const environmentInterval = Number(process.env.MONITOR_INTERVAL_MINUTES);
  if (Number.isFinite(environmentInterval) && environmentInterval >= 5) {
    return Math.floor(environmentInterval);
  }

  return Math.max(5, configuredInterval ?? DEFAULT_MONITOR_INTERVAL_MINUTES);
}