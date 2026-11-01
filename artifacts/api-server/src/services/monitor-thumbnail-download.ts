/** One deadline covers both HTTP headers and the complete response body. */
export async function fetchThumbnailBytes(url: string, {
  timeoutMs = 10_000,
  maxBytes = 8 * 1024 * 1024,
  fetcher = fetch,
}: { timeoutMs?: number; maxBytes?: number; fetcher?: typeof fetch } = {}): Promise<Buffer | null> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Thumbnail download deadline exceeded"));
    }, timeoutMs);
  });
  try {
    response = await Promise.race([
      fetcher(url, { headers: { "User-Agent": "ChapterMonitor/1.0" }, signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok || !response.body) return null;
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) return null;
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(next.value));
    }
    return size ? Buffer.concat(chunks, size) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}