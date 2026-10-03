import { describe, expect, it } from "vitest";
import { numberActiveMonitorWorks, resolveMonitorWorkNumber } from "./monitor-work-numbering.js";

describe("monitor display numbers", () => {
  it("closes gaps without modifying IDs or the input", () => {
    const rows = [
      { id: 80, active: true, title: "C" },
      { id: 2, active: false, title: "B" },
      { id: 1, active: true, title: "A" },
    ];
    const before = structuredClone(rows);
    const numbered = numberActiveMonitorWorks(rows);
    expect(numbered.map(({ id, displayNumber }) => [id, displayNumber])).toEqual([[1, 1], [80, 2]]);
    expect(rows).toEqual(before);
    expect(resolveMonitorWorkNumber(numbered, 2)?.id).toBe(80);
    expect(resolveMonitorWorkNumber(numbered, 80)).toBeUndefined();
  });

  it("renumbers after removal, append and reactivation in a deterministic order", () => {
    const rows = [{ id: 1, active: true }, { id: 3, active: true }, { id: 9, active: true }];
    rows[1].active = false;
    expect(numberActiveMonitorWorks(rows).map((w) => [w.id, w.displayNumber])).toEqual([[1, 1], [9, 2]]);
    rows.push({ id: 12, active: true });
    expect(numberActiveMonitorWorks(rows).map((w) => [w.id, w.displayNumber])).toEqual([[1, 1], [9, 2], [12, 3]]);
    rows[1].active = true;
    expect(numberActiveMonitorWorks(rows).map((w) => [w.id, w.displayNumber])).toEqual([[1, 1], [3, 2], [9, 3], [12, 4]]);
  });

  it("handles an empty or completely paused monitor", () => {
    expect(numberActiveMonitorWorks([])).toEqual([]);
    expect(numberActiveMonitorWorks([{ id: 10, active: false }])).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid number %s", (number) => {
    expect(resolveMonitorWorkNumber([{ displayNumber: 1, id: 100 }], number)).toBeUndefined();
  });
});