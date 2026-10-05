import { describe, expect, it } from "vitest";
import { calendarAnimeDurationMinutes, isCalendarAnimeDurationAllowed } from "../calendar-anime-policy.js";

describe("calendar anime episode duration", () => {
  it.each([
    [1, 1], [9, 9], [10, 10], [24, 24],
    ["53 sec", 53 / 60], ["9 min 59 sec per ep", 9 + 59 / 60],
    ["10 min per ep", 10], ["24 min per ep", 24],
    ["1 hr 35 min", 95], ["1 hour 2 minutes 3 seconds", 62.05],
    [" 10 MIN PER EP. ", 10],
  ])("parses a documented duration %s", (input, expected) => {
    expect(calendarAnimeDurationMinutes(input)).toBeCloseTo(expected);
    expect(isCalendarAnimeDurationAllowed(input)).toBe(expected >= 10);
  });
  it.each([undefined, null, "", "Unknown", "24", "9 min trailer", "-1 min", 0, -1, NaN, Infinity, {}, "0 sec"])(
    "preserves works whose duration cannot be established (%s)", (input) => {
      expect(calendarAnimeDurationMinutes(input)).toBeNull();
      expect(isCalendarAnimeDurationAllowed(input)).toBe(true);
    },
  );
});
