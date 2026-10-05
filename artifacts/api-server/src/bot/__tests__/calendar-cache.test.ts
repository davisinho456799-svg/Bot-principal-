import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarCache } from "../calendar-cache.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("calendar shared cache", () => {
  it("coalesces simultaneous requests and serves fresh completed values", async () => {
    const cache = new CalendarCache<number[]>();
    let finish!: (value: number[]) => void;
    const loader = vi.fn(() => new Promise<number[]>((resolve) => { finish = resolve; }));
    const first = cache.get("month", loader);
    const second = cache.get("month", loader);
    await Promise.resolve();
    finish([1, 2]);
    expect((await first).value).toEqual([1, 2]);
    expect((await second).value).toEqual([1, 2]);
    expect((await cache.get("month", loader)).stale).toBe(false);
    expect(loader).toHaveBeenCalledOnce();
  });
  it("caches valid empty responses", async () => {
    const cache = new CalendarCache<number[]>();
    const loader = vi.fn(async () => []);
    await cache.get("empty", loader);
    await cache.get("empty", loader);
    expect(loader).toHaveBeenCalledOnce();
  });
  it("refreshes after five minutes and preserves the original time on failure", async () => {
    const cache = new CalendarCache<number>();
    const loader = vi.fn().mockResolvedValueOnce(1).mockRejectedValue(new Error("offline"));
    const first = await cache.get("month", loader);
    vi.advanceTimersByTime(300_001);
    const stale = await cache.get("month", loader);
    expect(stale).toEqual({ ...first, stale: true });
    await cache.get("month", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_600_001);
    await expect(cache.get("month", loader)).rejects.toThrow("offline");
  });
  it("briefly caches failures without inventing empty values", async () => {
    const cache = new CalendarCache<number[]>();
    const loader = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([2]);
    await expect(cache.get("month", loader)).rejects.toThrow("offline");
    await expect(cache.get("month", loader)).rejects.toThrow("offline");
    expect(loader).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    expect((await cache.get("month", loader)).value).toEqual([2]);
  });
  it("honors longer source cooldowns", async () => {
    const cache = new CalendarCache<number>();
    const error = Object.assign(new Error("429"), { retryAfterMs: 120_000 });
    const loader = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(3);
    await expect(cache.get("month", loader)).rejects.toThrow("429");
    vi.advanceTimersByTime(60_000);
    await expect(cache.get("month", loader)).rejects.toThrow("429");
    expect(loader).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_001);
    expect((await cache.get("month", loader)).value).toBe(3);
  });
  it("bounds its keys without discarding pending requests", async () => {
    const cache = new CalendarCache<number>(300_000, 3_600_000, 2);
    let finish!: (value: number) => void;
    const pending = cache.get("pending", () => new Promise<number>((resolve) => { finish = resolve; }));
    await cache.get("old", async () => 1);
    await cache.get("new", async () => 2);
    finish(3);
    expect((await pending).value).toBe(3);
    const loader = vi.fn(async () => 4);
    expect((await cache.get("old", loader)).value).toBe(4);
    expect(loader).toHaveBeenCalledOnce();
  });
});
