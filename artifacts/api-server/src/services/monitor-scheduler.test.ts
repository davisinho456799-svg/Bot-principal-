import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  summary: { lastCheckedAt: null as Date | string | null, activeWorks: 7, uncheckedWorks: 0 },
  intervalMinutes: 60,
  readFailure: false,
  readSummary: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@workspace/db/schema", () => ({
  monitorConfigTable: {},
  monitoredWorksTable: { lastCheckedAt: "last_checked_at", active: "active" },
}));
vi.mock("@workspace/db", () => ({
  db: {
    select: (fields?: unknown) => ({
      from: () => ({
        limit: async () => {
          if (state.readFailure) throw new Error("database unavailable");
          return [{ intervalMinutes: state.intervalMinutes }];
        },
        where: async () => {
          state.readSummary();
          if (state.readFailure) throw new Error("database unavailable");
          return [{ ...state.summary }];
        },
      }),
    }),
  },
}));
vi.mock("../lib/logger.js", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("./monitor-service.js", () => ({ runMonitor: state.run }));

import { getMonitorDelayMs } from "./monitor-schedule.js";
import { startMonitorScheduler, stopMonitorScheduler } from "./monitor-scheduler.js";
import { logger } from "../lib/logger.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = new Date("2026-10-03T15:20:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("MONITOR_INTERVAL_MINUTES", "60");
  vi.clearAllMocks();
  state.summary = { lastCheckedAt: new Date(NOW.getTime() - 20 * MINUTE), activeWorks: 7, uncheckedWorks: 0 };
  state.intervalMinutes = 60;
  state.readFailure = false;
  state.run.mockImplementation(async () => {
    state.summary.lastCheckedAt = new Date();
    state.summary.uncheckedWorks = 0;
    return { worksChecked: 7, chaptersFound: 0, postsSent: 0 };
  });
});

afterEach(() => {
  stopMonitorScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("clock-aligned image monitor schedule", () => {
  it("waits 40 minutes until the next full hour after restart", async () => {
    await startMonitorScheduler();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "image_monitor_next_check_scheduled", nextCheckAt: "2026-10-03T16:00:00.000Z" }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(40 * MINUTE - 1);
    expect(state.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it("does not extend the deadline after repeated restarts", async () => {
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    stopMonitorScheduler();
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it.each(["overdue", "never checked"])("checks immediately when %s", async (scenario) => {
    state.summary.lastCheckedAt = scenario === "overdue" ? new Date(NOW.getTime() - 2 * HOUR) : null;
    state.summary.uncheckedWorks = scenario === "never checked" ? 7 : 0;
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40 * MINUTE - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("does not create multiple schedules when started twice", async () => {
    await Promise.all([startMonitorScheduler(), startMonitorScheduler()]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it("avoids empty-monitor hot loops", async () => {
    state.summary = { lastCheckedAt: null, activeWorks: 0, uncheckedWorks: 0 };
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(state.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not move the full-hour deadline after a manual check", async () => {
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    state.summary.lastCheckedAt = new Date();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("keeps the next slot at the full hour even when a round takes three minutes", async () => {
    state.run.mockImplementation(async () => {
      const checkedAt = new Date();
      await new Promise(resolve => setTimeout(resolve, 3 * MINUTE));
      state.summary.lastCheckedAt = checkedAt;
    });
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
  });

  it("does not overlap rounds that continue past the next full hour", async () => {
    let finish!: () => void;
    state.run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(40 * MINUTE + HOUR);
    expect(state.run).toHaveBeenCalledTimes(1);
    state.summary.lastCheckedAt = new Date();
    finish();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("recovers from a database outage without stopping or spinning", async () => {
    state.readFailure = true;
    await startMonitorScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state.run).not.toHaveBeenCalled();
    state.readFailure = false;
    state.summary.lastCheckedAt = new Date(NOW.getTime() - 2 * HOUR);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it("backs off and recovers when the scheduled check fails", async () => {
    state.summary.lastCheckedAt = new Date(NOW.getTime() - 2 * HOUR);
    state.run.mockRejectedValueOnce(new Error("provider unavailable"));
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("recovers when the database fails at the scheduled deadline", async () => {
    await startMonitorScheduler();
    state.readFailure = true;
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(state.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    state.readFailure = false;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it("does not spin if a check finishes without saving progress", async () => {
    state.summary.lastCheckedAt = null;
    state.run.mockResolvedValueOnce({ worksChecked: 0, chaptersFound: 0, postsSent: 0 });
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("does not overlap automatic checks even when restarted during a long run", async () => {
    let finish!: () => void;
    state.summary.lastCheckedAt = null;
    state.run.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(0);
    stopMonitorScheduler();
    await startMonitorScheduler();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
    state.summary.lastCheckedAt = new Date();
    finish();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(state.run).toHaveBeenCalledTimes(2);
  });

  it("stops without leaving scheduled checks behind", async () => {
    await startMonitorScheduler();
    stopMonitorScheduler();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(state.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("delay calculation", () => {
  it("accepts persisted ISO strings and handles exact deadlines", () => {
    expect(getMonitorDelayMs("2026-10-03T14:00:00Z", 60, NOW.getTime())).toBe(0);
    expect(getMonitorDelayMs("2026-10-03T15:03:00Z", 60, NOW.getTime())).toBe(40 * MINUTE);
  });

  it("moves the completed Brasília 15:39 round to 16:00, not 16:39", () => {
    expect(getMonitorDelayMs("2026-10-03T18:39:00Z", 60, Date.parse("2026-10-03T18:43:00Z"))).toBe(17 * MINUTE);
  });

  it("waits until the next hour if this exact hour has already been checked", () => {
    expect(getMonitorDelayMs("2026-10-03T16:00:00Z", 60, Date.parse("2026-10-03T16:00:00Z"))).toBe(HOUR);
  });

  it("handles the Brasília midnight boundary independently of server timezone", () => {
    expect(getMonitorDelayMs("2026-10-04T02:39:00Z", 60, Date.parse("2026-10-04T02:59:59Z"))).toBe(1000);
    expect(getMonitorDelayMs("2026-10-04T02:39:00Z", 60, Date.parse("2026-10-04T03:00:00Z"))).toBe(0);
  });

  it("preserves non-hourly configured intervals", () => {
    expect(getMonitorDelayMs("2026-10-03T15:00:00Z", 30, NOW.getTime())).toBe(10 * MINUTE);
  });

  it("does not let a corrupt or future timestamp postpone checks indefinitely", () => {
    expect(getMonitorDelayMs("invalid", 60, NOW.getTime())).toBe(0);
    expect(getMonitorDelayMs("2030-01-01T00:00:00Z", 60, NOW.getTime())).toBe(0);
  });

  it.each([NaN, Infinity, 0, -1])("rejects invalid interval %s", (interval) => {
    expect(() => getMonitorDelayMs(null, interval, NOW.getTime())).toThrow("Invalid image monitor interval");
  });
});