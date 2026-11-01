import { type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInteractionRouter } from "../interaction-router.js";
const mocks = vi.hoisted(() => ({ calendar: vi.fn() }));
vi.mock("../calendar-panel.js", () => ({ handleCalendarComponent: mocks.calendar }));
vi.mock("../command-registry.js", () => ({ commandRegistry: new Map() }));
vi.mock("../../routes/discord.js", () => ({
  config: vi.fn(), getConfiguredSeasonPage: vi.fn(),
}));
vi.mock("../usage-logger.js", () => ({ logUsage: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });
describe("calendar component routing", () => {
  it.each(["button", "select"])("dispatches permanent %s interactions without a command or collector", async (kind) => {
    const client = { on: vi.fn() };
    registerInteractionRouter(client as unknown as Client);
    const dispatch = client.on.mock.calls[0][1] as (value: unknown) => Promise<void>;
    const click = {
      type: 3, id: "click", guildId: "guild",
      customId: "calendar:v1:normal:anime:hoje:0:open",
      isButton: () => kind === "button",
      isStringSelectMenu: () => kind === "select",
      isChatInputCommand: () => false, isAutocomplete: () => false,
    };
    mocks.calendar.mockResolvedValue(true);
    await dispatch(click);
    expect(mocks.calendar).toHaveBeenCalledWith(click);
  });
  it("leaves unrelated components available to their existing handlers", async () => {
    const client = { on: vi.fn() };
    registerInteractionRouter(client as unknown as Client);
    const dispatch = client.on.mock.calls[0][1] as (value: unknown) => Promise<void>;
    const click = {
      type: 3, id: "other", customId: "other_button",
      isButton: () => true, isStringSelectMenu: () => false,
      isChatInputCommand: () => false, isAutocomplete: () => false, isModalSubmit: () => false,
    };
    mocks.calendar.mockResolvedValue(false);
    await dispatch(click);
    expect(mocks.calendar).toHaveBeenCalledOnce();
  });
});
