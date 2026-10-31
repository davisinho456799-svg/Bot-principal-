/** Display numbers may change; database IDs and chapter history must never change. */
export function numberActiveMonitorWorks<T extends { id: number; active: boolean }>(
  works: readonly T[],
): Array<T & { displayNumber: number }> {
  return works
    .filter((work) => work.active)
    .sort((a, b) => a.id - b.id)
    .map((work, index) => ({ ...work, displayNumber: index + 1 }));
}

export function resolveMonitorWorkNumber<T extends { displayNumber: number }>(
  works: readonly T[],
  number: number,
): T | undefined {
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return works.find((work) => work.displayNumber === number);
}