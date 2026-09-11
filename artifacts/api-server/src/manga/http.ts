export class ExternalSourceError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ExternalSourceError";
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new ExternalSourceError(message);
  }

  if (!response.ok) {
    throw new ExternalSourceError(
      `External source returned HTTP ${response.status}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ExternalSourceError("External source returned invalid JSON", response.status);
  }
}

export function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function uniqueTitles(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const title = value?.trim();
    if (!title) continue;
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(title);
  }

  return result;
}