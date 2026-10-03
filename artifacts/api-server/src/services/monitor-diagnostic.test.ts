import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  works: [] as Array<{ id: number; displayNumber: number; title: string; platform: string; listingUrl: string; lastCheckedAt: Date | null }>,
  open: vi.fn(), writes: vi.fn(), info: vi.fn(), close: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ db: {
  select: () => ({ from: () => ({ limit: async () => [{ intervalMinutes: 60 }] }) }),
  update: state.writes, insert: state.writes, delete: state.writes, transaction: state.writes,
} }));
vi.mock("@workspace/db/schema", () => ({ monitorConfigTable: {} }));
vi.mock("./monitor-work-list", () => ({ getActiveNumberedMonitorWorks: async () => state.works }));
vi.mock("./browser-chapter-capture", () => ({ openBrowserListing: state.open }));
vi.mock("../lib/logger", () => ({ logger: { info: state.info } }));
import { runMonitorDiagnostic, formatMonitorDiagnostic } from "./monitor-diagnostic";
import { monitorExecution } from "./monitor-execution";
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  state.works = [1, 10].map((id, i) => ({
    id, displayNumber: i + 1, title: `Obra ${i + 1}`, platform: "lezhin",
    listingUrl: "https://example.test", lastCheckedAt: new Date(),
  }));
  state.close.mockResolvedValue(undefined);
  state.open.mockResolvedValue({
    candidates: [{ captureId: "card", number: "12" }],
    captureGroups: async () => [{ image: Buffer.from("image") }],
    close: state.close,
  });
});

describe("read-only diagnostics", () => {
  it("compares measured phases and ranks the slower work first", async () => {
    let now = 0, count = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    state.open.mockImplementation(async () => {
      now += ++count === 1 ? 100 : 800;
      return {
        candidates: [{ captureId: "card" }],
        captureGroups: async () => { now += 20; return [{ image: Buffer.from("image") }]; },
        close: async () => { now += 15; },
      };
    });
    const report = await runMonitorDiagnostic();
    expect(report.results.map(r => r.number)).toEqual([2, 1]);
    expect(report.results[0]).toMatchObject({ lookupMs: 800, captureMs: 20, cleanupMs: 15, durationMs: 835 });
    expect(report.durationMs).toBe(970);
  });

  it("honors the time limit and stops before starting another work", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    state.open.mockImplementationOnce(async () => { controller.abort(); throw new Error("timeout"); });
    const report = await runMonitorDiagnostic();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(6 * 60_000);
    expect(report.status).toBe("interrupted");
    expect(report.worksSkipped).toBe(1);
    expect(state.open).toHaveBeenCalledTimes(1);
  });

  it("records cleanup failures without abandoning the other works", async () => {
    state.close.mockRejectedValueOnce(new Error("close failed"));
    const report = await runMonitorDiagnostic();
    expect(report.status).toBe("partial");
    expect(report.results.filter(r => r.status === "failed")).toHaveLength(1);
    expect(state.close).toHaveBeenCalledTimes(2);
  });
  it("captures one card per work, preserves timestamps and never writes to the database", async () => {
    const before = JSON.stringify(state.works);
    const result = await runMonitorDiagnostic();
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.imageCaptured && r.status === "completed")).toBe(true);
    expect(state.open).toHaveBeenCalledWith("https://example.test", "lezhin", true, expect.any(AbortSignal));
    expect(state.close).toHaveBeenCalledTimes(2);
    expect(state.writes).not.toHaveBeenCalled();
    expect(JSON.stringify(state.works)).toBe(before);
  });

  it("refuses to start near the automatic deadline or with unchecked works", async () => {
    state.works[0].lastCheckedAt = new Date(Date.now() - 55 * 60_000);
    state.works[1].lastCheckedAt = state.works[0].lastCheckedAt;
    await expect(runMonitorDiagnostic()).rejects.toThrow("automática");
    state.works[0].lastCheckedAt = null;
    await expect(runMonitorDiagnostic()).rejects.toThrow("automática");
    expect(state.open).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("continues after a failed work without publishing or exposing raw errors", async () => {
    state.open.mockRejectedValueOnce(new Error("private-url-and-password"));
    const result = await runMonitorDiagnostic();
    expect(result.status).toBe("partial");
    expect(result.results.filter(r => r.status === "failed")).toHaveLength(1);
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private-url");
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("handles empty works and limits a selected diagnostic to its immutable ID", async () => {
    state.open.mockResolvedValueOnce({ candidates: [], close: state.close });
    const result = await runMonitorDiagnostic(10);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ workId: 10, number: 2, status: "empty" });
    await expect(runMonitorDiagnostic(99)).rejects.toThrow("não está mais ativa");
  });

  it("interrupts and cleans up before giving priority to a regular verification", async () => {
    state.open.mockImplementationOnce(async (_url, _platform, _retry, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { candidates: [], close: state.close };
    });
    const diagnostic = runMonitorDiagnostic();
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
    await monitorExecution.runRegular(async () => {
      expect(state.close).toHaveBeenCalledTimes(1);
    });
    const report = await diagnostic;
    expect(report.status).toBe("interrupted");
    expect(report.worksSkipped).toBe(1);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("renders comparison details and does not claim these are notification timings", () => {
    const text = formatMonitorDiagnostic({ roundId: "test", durationMs: 1300, status: "completed", worksSkipped: 0,
      results: [{ workId: 1, number: 1, title: "Obra", status: "completed", durationMs: 1200, lookupMs: 1000, captureMs: 150, cleanupMs: 50, chaptersFound: 4, imageCaptured: true }] });
    expect(text).toContain("1.20 s");
    expect(text).toContain("Sem envio");
    expect(text).toContain("captura de 1 card");
  });
});