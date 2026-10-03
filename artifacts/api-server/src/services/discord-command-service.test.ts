import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; active: boolean; title: string; platform: string; listingUrl: string; lastStatus: string | null }>,
  action: "confirm" as "confirm" | "cancel" | "timeout" | "ack-failure",
  onPrompt: undefined as (() => void) | undefined,
  updates: vi.fn(),
  insert: vi.fn(),
  notification: vi.fn(),
  diagnostic: vi.fn(),
  resend: vi.fn(),
  acknowledge: vi.fn(),
  nextId: 11,
}));

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown) => ({ field, value }),
  and: (...conditions: unknown[]) => ({ conditions }),
}));
vi.mock("@workspace/db/schema", () => ({
  monitoredWorksTable: { id: "id", active: "active", listingUrl: "listingUrl" },
  monitorConfigTable: { id: "id" },
  monitorHistoryTable: {},
}));
vi.mock("@workspace/db", () => {
  type Condition = { field?: string; value?: unknown; conditions?: Condition[] };
  const matches = (row: Record<string, unknown>, condition: Condition): boolean =>
    condition.conditions
      ? condition.conditions.every((item) => matches(row, item))
      : row[condition.field!] === condition.value;
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (condition: Condition) => ({
            then: (resolve: (rows: typeof state.rows) => unknown) =>
              Promise.resolve(state.rows.filter((row) => matches(row, condition))).then(resolve),
            limit: async (count: number) => state.rows.filter((row) => matches(row, condition)).slice(0, count),
          }),
        }),
      }),
      insert: () => ({
        values: (values: object) => ({
          returning: async () => {
            state.insert(values);
            const row = { id: state.nextId++, active: true, lastStatus: null, ...values } as typeof state.rows[number];
            state.rows.push(row);
            return [row];
          },
        }),
      }),
      update: () => ({
        set: (values: object) => ({
          where: (condition: Condition) => ({
            returning: async () => {
              state.updates(values, condition);
              const matched = state.rows.filter((row) => matches(row, condition));
              matched.forEach((row) => Object.assign(row, values));
              return matched;
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("./monitor-service.js", () => ({
  runMonitor: vi.fn(),
  runTestNotification: state.notification,
  runResendNotification: state.resend,
}));
vi.mock("./monitor-diagnostic.js", () => ({
  runMonitorDiagnostic: state.diagnostic,
  formatMonitorDiagnostic: () => "Comparação dos tempos, sem notificações",
}));

import { executeManhwaCommand, monitorCommandDefinition } from "./discord-command-service.js";

function interaction(subcommand: string, number: number | null = null) {
  let confirmationIds: string[] = [];
  const message = {
    awaitMessageComponent: vi.fn(async (options) => {
      if (state.action === "timeout") throw new Error("collector timed out");
      const button = {
        user: { id: "owner" },
        customId: confirmationIds[state.action === "cancel" ? 1 : 0],
        deferUpdate: state.acknowledge,
      };
      expect(options.filter({ ...button, user: { id: "other" } })).toBe(false);
      expect(options.filter({ ...button, customId: "unrelated" })).toBe(false);
      expect(options.filter(button)).toBe(true);
      return button;
    }),
  };
  const fake = {
    id: "interaction-1",
    user: { id: "owner" },
    deferred: true,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (payload) => {
      if (payload.components?.length) {
        confirmationIds = payload.components[0].toJSON().components.map((button: { custom_id: string }) => button.custom_id);
        state.onPrompt?.();
      }
      return message;
    }),
    options: {
      getSubcommand: () => subcommand,
      getInteger: () => number,
      getString: (key: string) => ({ link: "https://www.lezhin.com/new", nome: "D", plataforma: "lezhin", capitulo: "12.5" })[key],
    },
  };
  return { fake, command: fake as unknown as ChatInputCommandInteraction };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [
    { id: 10, title: "C", active: true, platform: "lezhin", listingUrl: "https://example.test/c", lastStatus: "Check failed" },
    { id: 2, title: "B", active: false, platform: "lezhin", listingUrl: "https://example.test/b", lastStatus: "Check failed: paused" },
    { id: 1, title: "A", active: true, platform: "lezhin", listingUrl: "https://example.test/a", lastStatus: null },
  ];
  state.action = "confirm";
  state.onPrompt = undefined;
  state.nextId = 11;
  state.acknowledge.mockResolvedValue(undefined);
  state.notification.mockResolvedValue({ title: "C", chapter: "1", parser: "test", captureMode: "test" });
  state.resend.mockResolvedValue({ title: "C", chapter: "12.5", parser: "test", imageMode: "none" });
  state.diagnostic.mockResolvedValue({ results: [], worksSkipped: 0 });
});

describe("safe monitor commands", () => {
  it("supports all-work diagnostics and resolves a selected display number to its immutable ID", async () => {
    expect(monitorCommandDefinition.options?.some(o => o.name === "diagnostico")).toBe(true);
    const all = interaction("diagnostico");
    await executeManhwaCommand(all.command);
    expect(state.diagnostic).toHaveBeenCalledWith(undefined);
    await executeManhwaCommand(interaction("diagnostico", 2).command);
    expect(state.diagnostic).toHaveBeenCalledWith(10);
    expect(all.fake.editReply.mock.calls.at(-1)?.[0].content).toContain("Comparação");
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.resend).not.toHaveBeenCalled();
    expect(state.updates).not.toHaveBeenCalled();
  });

  it("does not run a diagnostic with an invalid work number", async () => {
    await executeManhwaCommand(interaction("diagnostico", 99).command);
    expect(state.diagnostic).not.toHaveBeenCalled();
  });

  it("does not expose database error messages in the private response", async () => {
    state.diagnostic.mockRejectedValueOnce(new Error("secret-in-database-url"));
    const { fake, command } = interaction("diagnostico");
    await executeManhwaCommand(command);
    expect(JSON.stringify(fake.editReply.mock.calls)).not.toContain("secret-in-database-url");
  });
  it("lists consecutive numbers, not the database IDs", async () => {
    const { fake, command } = interaction("listar");
    await executeManhwaCommand(command);
    const content = fake.editReply.mock.calls[0][0].content;
    expect(content).toContain("Nº 1 — A");
    expect(content).toContain("Nº 2 — C");
    expect(content).not.toContain("ID 10");
    expect(content).not.toContain("— B");
    expect(state.updates).not.toHaveBeenCalled();
  });

  it("tests the database ID selected by the current display number", async () => {
    await executeManhwaCommand(interaction("teste", 2).command);
    expect(state.notification).toHaveBeenCalledWith(expect.any(Function), 10);
  });

  it("resends using the immutable ID of the current display number", async () => {
    await executeManhwaCommand(interaction("reenviar", 2).command);
    expect(state.resend).toHaveBeenCalledWith(10, "12.5", expect.any(Function));
  });

  it("renames only the confirmed work when numbers shift", async () => {
    state.onPrompt = () => { state.rows.find((row) => row.id === 1)!.active = false; };
    const { fake, command } = interaction("renomear", 2);
    await executeManhwaCommand(command);
    expect(fake.editReply.mock.calls[0][0].content).toContain("Renomear **C** (nº 2) para **D**");
    expect(state.rows.find((row) => row.id === 10)!.title).toBe("D");
    expect(state.rows.find((row) => row.id === 1)!.title).toBe("A");
    expect(state.rows.find((row) => row.id === 10)!.active).toBe(true);
    expect(state.updates).toHaveBeenCalledWith(
      { title: "D", updatedAt: expect.any(Date) },
      { conditions: [{ field: "id", value: 10 }, { field: "active", value: true }] },
    );
  });

  it("does not rename when the user cancels", async () => {
    state.action = "cancel";
    await executeManhwaCommand(interaction("renomear", 2).command);
    expect(state.updates).not.toHaveBeenCalled();
    expect(state.rows.find((row) => row.id === 10)!.title).toBe("C");
  });

  it("preserves random tests when no number is specified", async () => {
    await executeManhwaCommand(interaction("teste").command);
    expect(state.notification).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it.each(["teste", "remover", "renomear", "reenviar"])("rejects an old internal ID for %s without falling back", async (command) => {
    await executeManhwaCommand(interaction(command, 10).command);
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.resend).not.toHaveBeenCalled();
    expect(state.updates).not.toHaveBeenCalled();
  });

  it("pins removal to the confirmed ID even if numbers shift while confirming", async () => {
    state.onPrompt = () => { state.rows.find((row) => row.id === 1)!.active = false; };
    const { fake, command } = interaction("remover", 2);
    await executeManhwaCommand(command);
    expect(fake.editReply.mock.calls[0][0].content).toContain("**C** (nº 2)");
    expect(state.updates).toHaveBeenCalledWith(
      { active: false, updatedAt: expect.any(Date) },
      { conditions: [{ field: "id", value: 10 }, { field: "active", value: true }] },
    );
    expect(state.acknowledge).toHaveBeenCalledTimes(1);
    expect(state.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(state.updates.mock.invocationCallOrder[0]);
    expect(fake.editReply.mock.calls.at(-1)![0].components).toEqual([]);
  });

  it.each(["cancel", "timeout", "ack-failure"] as const)("never changes a work on %s", async (action) => {
    state.action = action;
    if (action === "ack-failure") state.acknowledge.mockRejectedValueOnce(new Error("acknowledgement failed"));
    const command = interaction("remover", 2).command;
    if (action === "ack-failure") await expect(executeManhwaCommand(command)).rejects.toThrow("acknowledgement failed");
    else await executeManhwaCommand(command);
    expect(state.updates).not.toHaveBeenCalled();
  });

  it("does not change another work if the selected work was already paused", async () => {
    state.onPrompt = () => { state.rows.find((row) => row.id === 10)!.active = false; };
    const { fake, command } = interaction("remover", 2);
    await executeManhwaCommand(command);
    expect(fake.editReply.mock.calls.at(-1)![0].content).toContain("Nenhuma outra obra foi alterada");
    expect(state.rows.find((row) => row.id === 1)!.active).toBe(true);
  });

  it("uses the same numbers in the error list", async () => {
    const { fake, command } = interaction("erros");
    await executeManhwaCommand(command);
    expect(fake.editReply.mock.calls[0][0].content).toContain("Nº 2");
    expect(fake.editReply.mock.calls[0][0].content).not.toContain("**B**");
  });

  it("shows the current number of a newly added work", async () => {
    const { fake, command } = interaction("adicionar");
    await executeManhwaCommand(command);
    expect(fake.editReply.mock.calls.at(-1)![0].content).toContain("Número atual da obra: 3");
    expect(state.rows.find((row) => row.title === "D")!.id).toBe(11);
  });

  it("retains integer option names for compatibility but requires positive numbers", () => {
    for (const name of ["remover", "teste", "renomear", "reenviar"]) {
      const command = monitorCommandDefinition.options!.find((option) => option.name === name);
      expect(command?.options?.[0]).toMatchObject({ type: 4, min_value: 1 });
    }
  });
});