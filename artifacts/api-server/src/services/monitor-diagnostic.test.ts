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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T15:20:00Z"));
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

  it("enforces the time limit at work boundaries if the timeout signal has not fired", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    state.works = [1, 2, 3].map(id => ({
      id, displayNumber: id, title: `Obra ${id}`, platform: "lezhin",
      listingUrl: "https://example.test", lastCheckedAt: new Date(),
    }));
    state.open.mockImplementation(async () => {
      now += 4 * 60_000;
      return {
        candidates: [{ captureId: "card" }],
        captureGroups: async () => [{ image: Buffer.from("image") }],
        close: state.close,
      };
    });

    const report = await runMonitorDiagnostic();

    expect(state.open).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ status: "interrupted", worksSkipped: 1 });
    expect(report.results.at(-1)).toMatchObject({ status: "interrupted" });
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

  it("returns the selected work's captured image only for a private preview and never logs image bytes", async () => {
    const image = Buffer.from("private-preview");
    state.open.mockResolvedValue({
      candidates: [{ captureId: "card", number: "117" }],
      captureGroups: async () => [{ image }],
      close: state.close,
    });

    const report = await runMonitorDiagnostic(1);

    expect(report.previewImage).toEqual(image);
    expect(state.info.mock.calls.at(-1)?.[0]).not.toHaveProperty("previewImage", image);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("uses the automatic paired capture path for Toptoon works", async () => {
    state.works = [{
      id: 1, displayNumber: 1, title: "Obra Toptoon", platform: "toptoon",
      listingUrl: "https://example.test/toptoon", lastCheckedAt: new Date(),
    }];
    const captureGroups = vi.fn(async () => [{ image: Buffer.from("image") }]);
    state.open.mockResolvedValue({
      candidates: [{ captureId: "card", number: "12", extraThumbnailUrls: ["extra-2", "extra-3"] }],
      captureGroups,
      close: state.close,
    });

    const report = await runMonitorDiagnostic();

    expect(captureGroups).toHaveBeenCalledWith(["card"], [], true);
    expect(report.results[0]).toMatchObject({ status: "completed", imageCaptured: true });
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
    state.open.mockRejectedValueOnce(new Error("navigation failed: access_token=private-url-and-password; url=https://example.test/list"));
    const result = await runMonitorDiagnostic();
    expect(result.status).toBe("partial");
    const failed = result.results.filter(r => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.issue).toMatchObject({ stage: "listing" });
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private-url");
    expect(JSON.stringify(result)).not.toContain("example.test");
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("reports capture-stage failures with a sanitized reason", async () => {
    state.open.mockResolvedValueOnce({
      candidates: [{ captureId: "card", number: "12" }],
      captureGroups: async () => { throw new Error("capture timed out at https://example.test/card?token=secret-value"); },
      close: state.close,
    });
    const result = await runMonitorDiagnostic();
    expect(result.results[0]).toMatchObject({
      status: "failed",
      chaptersFound: 1,
      issue: { stage: "capture" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("reports empty listings separately from browser failures", async () => {
    state.open.mockResolvedValueOnce({ candidates: [], close: state.close });
    const result = await runMonitorDiagnostic(1);
    expect(result.results[0]).toMatchObject({
      status: "empty",
      issue: { stage: "listing", reason: "A listagem não encontrou capítulos utilizáveis." },
    });
  });

  it("includes safe browser context for empty listings", async () => {
      state.open.mockResolvedValueOnce({
        candidates: [],
        diagnostics: {
          finalUrl: "https://global.toomics.com/por/login?access_token=private-value",
          pageTitle: "Toomics Login",
          bodyTextLength: 42,
          visibleImageCount: 0,
          signals: ["login", "unrecognized-signal"],
          authentication: "credenciais não configuradas",
        },
        close: state.close,
      });

      const result = await runMonitorDiagnostic(1);
      const formatted = formatMonitorDiagnostic(result);

      expect(result.results[0]?.browser).toMatchObject({
        page: "global.toomics.com/por/login",
        title: "Toomics Login",
        bodyTextLength: 42,
        visibleImageCount: 0,
        signals: ["login"],
        authentication: "credenciais não configuradas",
      });
      expect(formatted).toContain("autenticação=credenciais não configuradas");
      expect(JSON.stringify(result)).not.toContain("private-value");
    });

      it("reports only safe categories for technical login errors", async () => {
    const cases = [
      ["TimeoutError: locator.fill: Timeout 8000ms exceeded.", "erro técnico no login (tempo esgotado)"],
      ["Error: Target page, context or browser has been closed", "erro técnico no login (página fechada)"],
      ["Error: net::ERR_TUNNEL_CONNECTION_FAILED", "erro técnico no login (falha de rede)"],
      ["[TypeError] (private-login-detail)", "erro técnico no login (tipo TypeError)"],
      ["[Error] (private-login-detail)", "erro técnico no login (erro genérico)"],
      ["[ReferenceError] (toomicsLoginHelper is not defined)", "erro técnico no login (símbolo toomicsLoginHelper não definido)"],
      ["[ReferenceError] (TOOMICS_PASSWORD is not defined)", "erro técnico no login (tipo ReferenceError)"],
      ["[ReferenceError] (DATABASE_URL is not defined)", "erro técnico no login (símbolo DATABASE_URL não definido)"],
      ["[ReferenceError] (URL is not defined)", "erro técnico no login (símbolo URL não definido)"],
    ] as const;

    for (const [detail, expected] of cases) {
      state.open.mockResolvedValueOnce({
        candidates: [],
        diagnostics: {
          finalUrl: "https://www.toomics.com/uplmscg/episode/toon/7189",
          pageTitle: "Someone Stop Her!",
          bodyTextLength: 42,
          visibleImageCount: 2,
          signals: [],
          authentication: `erro no login (${detail})`,
        },
        close: state.close,
      });

      const result = await runMonitorDiagnostic(1);
      const authentication = result.results[0]?.browser?.authentication;
      expect(authentication).toBe(expected);
      expect(JSON.stringify(result)).not.toContain(detail);
    }
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
      results: [{ workId: 1, number: 1, title: "Obra", status: "failed", durationMs: 1200, lookupMs: 1000, captureMs: 150, cleanupMs: 50, chaptersFound: 4, imageCaptured: false, issue: { stage: "capture", reason: "tempo esgotado" } }] });
    expect(text).toContain("1.20 s");
    expect(text).toContain("Sem envio");
    expect(text).toContain("captura do formato usado pelo monitor");
    expect(text).toContain("Etapa: captura · motivo: tempo esgotado");
  });
});