import { describe, expect, it } from "vitest";
import { parseAdultSubscriptionChoice, parseSubscriptionChoice } from "../subscription-choice.js";

describe("subscription autocomplete source validation", () => {
  it("allows Tenrai for anime, manga, and manhwa", () => {
    for (const kind of ["anime", "manga", "manhwa"] as const) {
      expect(parseSubscriptionChoice(kind, "tenrai:123")).toMatchObject({
        kind: kind === "anime" ? "anime" : "manga",
        source: "tenrai",
        id: "123",
      });
    }
  });

  it("allows Kitsu for anime only", () => {
    expect(parseSubscriptionChoice("anime", "kitsu:42")).toEqual({
      kind: "anime",
      source: "kitsu",
      id: "42",
    });
    expect(parseSubscriptionChoice("manga", "kitsu:42")).toBeNull();
    expect(parseSubscriptionChoice("manhwa", "kitsu:42")).toBeNull();
  });

  it("rejects sources that do not match the selected media type or lack an ID", () => {
    expect(parseSubscriptionChoice("anime", "anilist:123")).toBeNull();
    expect(parseSubscriptionChoice("manga", "anilist-anime:123")).toBeNull();
    expect(parseSubscriptionChoice("anime", "kitsu:")).toBeNull();
  });

  it("accepts +18 Kitsu anime and maps the legacy Jikan anime value to its lookup source", () => {
    expect(parseAdultSubscriptionChoice("anime", "kitsu:42")).toMatchObject({
      kind: "anime",
      source: "kitsu",
      id: "42",
    });
    expect(parseAdultSubscriptionChoice("anime", "jikan-anime:21")).toMatchObject({
      kind: "anime",
      source: "jikan",
      id: "21",
    });
    expect(parseAdultSubscriptionChoice("manga", "kitsu:42")).toBeNull();
  });
});
