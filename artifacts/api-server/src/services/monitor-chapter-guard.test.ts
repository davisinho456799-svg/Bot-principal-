import { describe, expect, it } from "vitest";
import {
  highestTrustedChapterNumber,
  isAbsurdChapterOutlier,
  trustedChapterNumbers,
} from "./monitor-chapter-guard";

describe("monitor chapter guard", () => {
  it("rejects a card number that is absurdly beyond the work history", () => {
    expect(isAbsurdChapterOutlier("7158", 67)).toBe(true);
    expect(isAbsurdChapterOutlier("68", 67)).toBe(false);
  });

  it("keeps the trusted history ceiling before a huge parsing jump", () => {
    expect(highestTrustedChapterNumber(["1", "2", "66", "67", "7158"])).toBe(67);
    expect(trustedChapterNumbers(["1", "2", "66", "67", "7158"])).toEqual([
      1,
      2,
      66,
      67,
    ]);
  });
});