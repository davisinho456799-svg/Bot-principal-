interface CacheRecord<T> {
  value?: T;
  fetchedAt: number;
  retryAt: number;
  error?: unknown;
  pending?: Promise<CalendarCached<T>>;
}

export interface CalendarCached<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
}

/** Shares completed consultations and concurrent refreshes, never partial pages. */
export class CalendarCache<T> {
  private readonly records = new Map<string, CacheRecord<T>>();
  constructor(
    private readonly freshMs = 5 * 60_000,
    private readonly staleMs = 60 * 60_000,
    private readonly maxKeys = 64,
  ) {}

  clear() { this.records.clear(); }

  async get(key: string, loader: () => Promise<T>): Promise<CalendarCached<T>> {
    const now = Date.now();
    let record = this.records.get(key);
    if (record?.value !== undefined && now - record.fetchedAt < this.freshMs) {
      return { value: record.value, fetchedAt: record.fetchedAt, stale: false };
    }
    if (record?.pending) return record.pending;
    const stale = (entry: CacheRecord<T>): CalendarCached<T> | null =>
      entry.value !== undefined && Date.now() - entry.fetchedAt < this.staleMs
        ? { value: entry.value, fetchedAt: entry.fetchedAt, stale: true } : null;
    if (record && record.retryAt > now) {
      const previous = stale(record);
      if (previous) return previous;
      throw record.error;
    }
    if (!record) {
      for (const [id, entry] of this.records) {
        if (!entry.pending && now - entry.fetchedAt >= this.staleMs && entry.retryAt <= now) {
          this.records.delete(id);
        }
      }
      if (this.records.size >= this.maxKeys) {
        const removable = [...this.records].find(([, entry]) => !entry.pending);
        if (removable) this.records.delete(removable[0]);
        else throw new Error("Muitas consultas de calendário simultâneas");
      }
      record = { fetchedAt: 0, retryAt: 0 };
      this.records.set(key, record);
    }
    const entry = record;
    entry.pending = Promise.resolve().then(loader).then((value) => {
      entry.value = value;
      entry.fetchedAt = Date.now();
      entry.retryAt = 0;
      entry.error = undefined;
      return { value, fetchedAt: entry.fetchedAt, stale: false };
    }).catch((error: unknown) => {
      entry.error = error;
      const retryMs = error instanceof Error && "retryAfterMs" in error
        ? Number(error.retryAfterMs) : 30_000;
      entry.retryAt = Date.now() + Math.min(300_000, Math.max(30_000, retryMs || 30_000));
      const previous = stale(entry);
      if (previous) return previous;
      throw error;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
}
