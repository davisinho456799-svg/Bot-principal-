const INTERACTION_CALLBACK_ROUTE = "/interactions/:id/:token/callback";

let interactionCallbackBlockedUntil = 0;

export function isInteractionCallbackRoute(route: unknown): boolean {
  return String(route).includes(INTERACTION_CALLBACK_ROUTE);
}

export function blockInteractionCallbacks(durationMs: number): void {
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