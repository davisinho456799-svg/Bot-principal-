let interactionCallbackBlockedUntil = 0;

export function blockInteractionCallbacks(durationMs: number, isGlobal: boolean): void {
  if (!isGlobal) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  interactionCallbackBlockedUntil = Math.max(
    interactionCallbackBlockedUntil,
    Date.now() + Math.ceil(durationMs),
  );
}

export function interactionCallbackCooldownRemaining(): number {
  return Math.max(0, interactionCallbackBlockedUntil - Date.now());
}

export function isDiscordRateLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "RateLimitError";
}