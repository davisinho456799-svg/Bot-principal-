export type ChapterNumberRecord = {
  number: string;
  publishedAt?: Date | null;
};

const OUTLIER_MIN_GAP = 100;
const OUTLIER_MULTIPLIER = 4;

export function chapterNumberIdentity(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}

export function numericChapterNumber(value: string): number | null {
  const number = Number(value.replace(",", ".").trim());
  return Number.isFinite(number) ? number : null;
}

/**
 * Returns the numeric history before the first jump that is too large to be
 * credible for the same work. This keeps one bad card number from becoming
 * the new ceiling for all future checks.
 */
export function trustedChapterNumbers(numbers: readonly string[]): number[] {
  const sorted = [...new Set(
    numbers
      .map(numericChapterNumber)
      .filter((number): number is number => number !== null),
  )].sort((left, right) => left - right);

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (
      current - previous > OUTLIER_MIN_GAP &&
      current > previous * OUTLIER_MULTIPLIER
    ) {
      return sorted.slice(0, index);
    }
  }
  return sorted;
}

export function highestTrustedChapterNumber(
  numbers: readonly string[],
): number | null {
  const trusted = trustedChapterNumbers(numbers);
  return trusted.length ? trusted[trusted.length - 1]! : null;
}

export function isAbsurdChapterOutlier(
  value: string,
  highestKnown: number | null,
): boolean {
  const number = numericChapterNumber(value);
  return highestKnown !== null &&
    number !== null &&
    number > highestKnown &&
    number - highestKnown > OUTLIER_MIN_GAP &&
    number > highestKnown * OUTLIER_MULTIPLIER;
}