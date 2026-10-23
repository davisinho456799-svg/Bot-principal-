import { describe, expect, it } from "vitest";
import { MonitorExecution } from "./monitor-execution";

describe("image monitor priority", () => {
  it("rejects parallel diagnostics and diagnostics during a regular round", async () => {
    const gate = new MonitorExecution();
    await gate.runDiagnostic(async () => {
      await expect(gate.runDiagnostic(async () => {})).rejects.toThrow("ocupado");
    });
    await gate.runRegular(async () => {
      await expect(gate.runDiagnostic(async () => {})).rejects.toThrow("ocupado");
      await expect(gate.runRegular(async () => {})).rejects.toThrow("em andamento");
    });
  });

  it("cancels the diagnostic and waits for cleanup before the regular round", async () => {
    const gate = new MonitorExecution(), events: string[] = [];
    const diagnostic = gate.runDiagnostic(async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => {
        events.push("cancelled");
        resolve();
      }, { once: true }));
      events.push("cleanup");
    });
    await gate.runRegular(async () => { events.push("regular"); });
    await diagnostic;
    expect(events).toEqual(["cancelled", "cleanup", "regular"]);
  });

  it("releases both locks after failure", async () => {
    const gate = new MonitorExecution();
    await expect(gate.runDiagnostic(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(gate.runRegular(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(gate.runDiagnostic(async () => 7)).resolves.toBe(7);
  });
});