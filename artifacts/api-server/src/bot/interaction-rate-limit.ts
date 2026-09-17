const INTERACTION_CALLBACK_ROUTE = "/interactions/:id/:token/callback";

let interactionCallbackBlockedUntil = 0;

export class InteractionCallbackCooldownError extends Error {
  constructor(public readonly remainingMs: number) {
    super(`Callbacks do Discord em cooldown por mais ${remainingMs}ms`);
    this.name = "InteractionCallbackCooldownError";
  }
}

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

export function isInteractionCallbackUnavailable(error: unknown): boolean {
  return (
    isDiscordRateLimitError(error) ||
    error instanceof InteractionCallbackCooldownError
  );
}