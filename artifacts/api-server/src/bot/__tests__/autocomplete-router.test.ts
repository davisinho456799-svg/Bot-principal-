import { Client, Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInteractionRouter } from "../interaction-router.js";
import { interactionCallbackCooldownRemaining } from "../interaction-rate-limit.js";

const { handler } = vi.hoisted(() => ({
  handler: vi.fn(async (interaction: { respond: (options: unknown[]) => Promise<void> }) =>
    interaction.respond([{ name: "Result", value: "result" }])),
}));
vi.mock("../command-registry.js", () => ({
  commandRegistry: new Map(["anime", "manhwa"].map(name => [name, { autocomplete: handler }])),
}));
vi.mock("../../routes/discord.js", () => ({
  config: vi.fn(), getConfiguredSeasonPage: vi.fn(),
}));
vi.mock("../interaction-rate-limit.js", () => ({
  interactionCallbackCooldownRemaining: vi.fn(() => 0),
  isDiscordRateLimitError: vi.fn(() => false),
}));

let serial = 0;
function fixture(commandName = "manhwa") {
  const userId = `test-${++serial}`;
  const client = { on: vi.fn() };
  registerInteractionRouter(client as unknown as Client);
  expect(client.on).toHaveBeenCalledWith(Events.InteractionCreate, expect.any(Function));
  const dispatch = client.on.mock.calls[0][1] as (interaction: unknown) => Promise<void>;
  const make = (value = "naruto") => {
    const interaction = {
      type: 4, id: `interaction-${++serial}`, commandName,
      user: { id: userId }, guildId: "test", createdTimestamp: Date.now(),
      responded: false,
      isModalSubmit: () => false, isButton: () => false, isStringSelectMenu: () => false,
      isAutocomplete: () => true, isChatInputCommand: () => false,
      options: { getFocused: () => value },
      respond: vi.fn(async (_options: unknown[]) => { interaction.responded = true; }),
    };
    const send = interaction.respond;
    return { interaction, send };
  };
  return { dispatch, make };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  handler.mockClear();
  handler.mockImplementation(async interaction =>
    interaction.respond([{ name: "Result", value: "result" }]));
  vi.mocked(interactionCallbackCooldownRemaining).mockReturnValue(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("autocomplete dispatch while typing", () => {
  it("responds to the latest query instead of discarding it inside the callback interval", async () => {
    const { dispatch, make } = fixture();
    const first = make();
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await firstRun;
    expect(first.send).toHaveBeenCalledTimes(1);

    const latest = make("naruto shippuden");
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    expect(latest.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await latestRun;
    expect(latest.send).toHaveBeenCalledTimes(1);
    expect(latest.interaction.responded).toBe(true);
  });

  it("replaces a waiting reply with the newer query and only acknowledges the latest", async () => {
    const { dispatch, make } = fixture();
    const first = make();
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await firstRun;
    const intermediate = make("naruto shi");
    const intermediateRun = dispatch(intermediate.interaction);
    await vi.advanceTimersByTimeAsync(250);
    const latest = make("naruto shippuden");
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([intermediateRun, latestRun]);
    expect(intermediate.send).not.toHaveBeenCalled();
    expect(latest.send).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid keystrokes before dispatching source work", async () => {
    const { dispatch, make } = fixture();
    const first = make("nar");
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(100);
    const latest = make("naruto");
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([firstRun, latestRun]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.send).not.toHaveBeenCalled();
    expect(latest.send).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge twice even when the handler calls respond concurrently", async () => {
    const { dispatch, make } = fixture();
    const first = make();
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await firstRun;
    handler.mockImplementation(async interaction => {
      await Promise.all([interaction.respond([]), interaction.respond([])]);
    });
    const latest = make();
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(500);
    await latestRun;
    expect(latest.send).toHaveBeenCalledTimes(1);
  });

  it("still respects an actual Discord callback cooldown", async () => {
    vi.mocked(interactionCallbackCooldownRemaining).mockReturnValue(5_000);
    const { dispatch, make } = fixture();
    const latest = make();
    const run = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await run;
    expect(latest.send).not.toHaveBeenCalled();
  });

  it("rechecks Discord cooldown after waiting, before sending the callback", async () => {
    const { dispatch, make } = fixture();
    const first = make();
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await firstRun;
    const latest = make();
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(interactionCallbackCooldownRemaining).mockReturnValue(5_000);
    await vi.advanceTimersByTimeAsync(250);
    await latestRun;
    expect(latest.send).not.toHaveBeenCalled();
  });

  it("does not add pacing delay when it would consume the response deadline", async () => {
    const { dispatch, make } = fixture();
    const first = make();
    const firstRun = dispatch(first.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await firstRun;
    const latest = make();
    latest.interaction.createdTimestamp -= 2_300;
    const latestRun = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await latestRun;
    expect(latest.send).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(100_500);
  });

  it("does not silently ignore short anime input before its handler can return empty choices", async () => {
    handler.mockImplementation(async interaction => interaction.respond([]));
    const { dispatch, make } = fixture("anime");
    const latest = make("n");
    const run = dispatch(latest.interaction);
    await vi.advanceTimersByTimeAsync(250);
    await run;
    expect(latest.send).toHaveBeenCalledExactlyOnceWith([]);
  });
});