import { describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("got-scraping", () => ({ gotScraping: request }));

import { fetchComick } from "../comick-http.js";

describe("Comick HTTP safety", () => {
  it("disables shared HTTP caching without changing the response contract", async () => {
    request.mockResolvedValueOnce({
      statusCode: 200,
      statusMessage: "OK",
      body: '{"chapters":12}',
      headers: { "content-type": "application/json" },
    });
    const result = await fetchComick("https://example.test/comick");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ cache: false }));
    expect(result).toMatchObject({ ok: true, status: 200, body: '{"chapters":12}' });
  });
});