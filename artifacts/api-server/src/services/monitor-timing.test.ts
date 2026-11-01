import { describe, expect, it } from "vitest";
import { measureImageMonitorRound } from "./monitor-timing";

describe("image monitor elapsed time", () => {
  function fixture() {
    let time = 0;
    const events: Record<string, unknown>[] = [];
    const options = { now: () => time, roundId: "round-test", log: { info: (fields: Record<string, unknown>) => { events.push(fields); } } };
    return { events, options, advance: (ms: number) => { time += ms; } };
  }

  it("records whole round, per-work duration and preserves the original result", async () => {
    const f = fixture();
    const result = await measureImageMonitorRound(async timing => {
      f.advance(250); // Configuration/database reads are included in total.
      const first = timing.startWork(1, "Primeira obra");
      f.advance(1200);
      first.finish();
      first.finish(); // A repeated cleanup cannot count the same work twice.
      const second = timing.startWork(2, "Segunda obra");
      f.advance(3500);
      second.finish();
      return { status: "completed", chaptersFound: 3 };
    }, f.options);
    expect(result).toEqual({ status: "completed", chaptersFound: 3 });
    const works = f.events.filter(e => e.event === "image_monitor_work_completed");
    expect(works.map(e => e.durationMs)).toEqual([1200, 3500]);
    expect(f.events.at(-1)).toMatchObject({ monitorType: "image", roundId: "round-test", durationMs: 4950, durationSeconds: 4.95, worksChecked: 2, worksFailed: 0, status: "completed" });
  });

  it("records a failed work and partial round without logging the error message", async () => {
    const f = fixture();
    await measureImageMonitorRound(async timing => {
      const work = timing.startWork(1, "Obra");
      f.advance(5000);
      work.fail(new Error("private-password-and-url"));
      work.finish();
    }, f.options);
    expect(f.events.at(-2)).toMatchObject({ durationSeconds: 5, status: "failed", errorName: "Error" });
    expect(f.events.at(-1)).toMatchObject({ status: "partial", worksFailed: 1 });
    expect(JSON.stringify(f.events)).not.toContain("private-password");
  });

  it("records fatal setup failures and rethrows the same error", async () => {
    const f = fixture(), error = new Error("configuration query failed");
    await expect(measureImageMonitorRound(async () => {
      f.advance(800);
      throw error;
    }, f.options)).rejects.toBe(error);
    expect(f.events.at(-1)).toMatchObject({ status: "failed", durationMs: 800, worksChecked: 0 });
  });

  it("records an empty round", async () => {
    const f = fixture();
    await measureImageMonitorRound(async () => {}, f.options);
    expect(f.events.at(-1)).toMatchObject({ durationMs: 0, worksChecked: 0, worksFailed: 0, status: "completed" });
  });

  it("includes browser cleanup failures in work and round timing", async () => {
    const f = fixture(), error = new Error("cleanup failed");
    await expect(measureImageMonitorRound(async timing => {
      const work = timing.startWork(1, "Obra");
      try {
        f.advance(1000);
        try { f.advance(300); throw error; }
        catch (failure) { work.fail(failure); throw failure; }
      } finally { work.finish(); }
    }, f.options)).rejects.toBe(error);
    expect(f.events.at(-2)).toMatchObject({ durationMs: 1300, status: "failed" });
    expect(f.events.at(-1)).toMatchObject({ durationMs: 1300, status: "failed", worksFailed: 1 });
  });
});