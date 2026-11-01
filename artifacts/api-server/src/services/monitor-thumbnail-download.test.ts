import { describe, expect, it, vi } from "vitest";
import { fetchThumbnailBytes } from "./monitor-thumbnail-download";

describe("bounded thumbnail HTTP downloads", () => {
  it("returns complete bytes without changing them", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    expect(await fetchThumbnailBytes("https://example.test/a", { fetcher })).toEqual(Buffer.from([1, 2, 3]));
  });
  it("aborts a request that never returns headers", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url, options) => {
      signal = options?.signal;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    expect(await fetchThumbnailBytes("https://example.test/a", { fetcher, timeoutMs: 20 })).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
  it("also times out a body that stops after the headers", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }))) as unknown as typeof fetch;
    expect(await fetchThumbnailBytes("https://example.test/a", { fetcher, timeoutMs: 20 })).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
  it.each([true, false])("rejects an oversized body, including without a length header (%s)", async hasHeader => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(10), {
      headers: hasHeader ? { "content-length": "10" } : {},
    })) as unknown as typeof fetch;
    expect(await fetchThumbnailBytes("https://example.test/a", { fetcher, maxBytes: 5 })).toBeNull();
  });
  it("returns null on HTTP or connection failure without blocking another download", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("ok")) as typeof fetch;
    expect(await fetchThumbnailBytes("https://example.test/a", { fetcher })).toBeNull();
    expect(await fetchThumbnailBytes("https://example.test/b", { fetcher })).toEqual(Buffer.from("ok"));
  });
});