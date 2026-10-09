import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.fn();
beforeEach(() => {
  vi.resetModules();
  request.mockReset();
  vi.stubGlobal("fetch", request);
});
afterEach(() => vi.unstubAllGlobals());

const raw = {
  id: "v123", title: "VN", alttitle: null, titles: [],
  description: null, rating: 75, votecount: 20, released: "2026-10-01",
  image: { url: "https://example.com/cover.jpg", sexual: 0, violence: 0 },
  length: 3, languages: ["ja", "en"], developers: [{ name: "Developer" }],
  tags: [{ name: "Mystery", rating: 2, spoiler: 0 }],
};

describe("VNDB calendar API contract", () => {
  it.each([false, true])("uses the real release classification, not cover flags (adult=%s)", async (adult) => {
    request.mockResolvedValue({ ok: true, json: async () => ({ results: [raw], more: false }) });
    const { fetchVNDBCalendar } = await import("../vndb.js");
    const entries = await fetchVNDBCalendar(adult);
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.filters).toContainEqual(["release", adult ? "=" : "!=", ["has_ero", "=", 1]]);
    expect(body.fields).toContain("tags.rating");
    expect(body.fields).not.toContain("languages.lang");
    expect(body.fields.split(",")).toContain("languages");
    expect(entries[0]).toMatchObject({
      vnId: "v123", languages: ["JA", "EN"], length: "Médio", tags: ["Mystery"],
    });
    // Adult VNs can have completely safe cover images.
    expect(entries).toHaveLength(1);
  });
  it("allows VNs with no cover because results do not expose images", async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ results: [{ ...raw, image: null }] }) });
    const { fetchVNDBCalendar } = await import("../vndb.js");
    expect(await fetchVNDBCalendar(false)).toHaveLength(1);
  });
  it("reports provider errors rather than an empty calendar", async () => {
    request.mockResolvedValue({ ok: false, status: 429 });
    const { fetchVNDBCalendar } = await import("../vndb.js");
    await expect(fetchVNDBCalendar(false)).rejects.toThrow("VNDB calendar HTTP 429");
  });
  it("rejects malformed provider responses", async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ error: "invalid" }) });
    const { fetchVNDBCalendar } = await import("../vndb.js");
    await expect(fetchVNDBCalendar(false)).rejects.toThrow("VNDB calendar response invalid");
  });
});
