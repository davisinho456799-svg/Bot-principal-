import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockInteractionCallbacks,
  interactionCallbackCooldownRemaining,
} from "../interaction-rate-limit.js";

describe("Discord global interaction callback cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks autocomplete callbacks only for a global REST rate limit", () => {
    blockInteractionCallbacks(5_000, false);
    expect(interactionCallbackCooldownRemaining()).toBe(0);
    blockInteractionCallbacks(2_500, true);
    blockInteractionCallbacks(5_000, false);
    expect(interactionCallbackCooldownRemaining()).toBe(2_500);
  });
});
