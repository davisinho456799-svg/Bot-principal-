import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { getTableName } from "drizzle-orm";
import { runMonitor } from "./monitor-service";
import { buildChapterKey } from "./parsers/index";

const state = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  listing: vi.fn(),
  records: {} as Record<string, Array<Record<string, any>>>,
}));
vi.mock("@workspace/db", () => ({ db: state.db }));
vi.mock("./browser-chapter-capture", () => ({ openBrowserListing: state.listing }));
vi.mock("./chapter-subtitle-translation", () => ({ translateChapterSubtitles: vi.fn(async () => {}) }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock("drizzle-orm", async original => ({
  ...await original<typeof import("drizzle-orm")>(),
  eq: (column: any, value: any) => (row: Record<string, any>, table: any) =>
    row[Object.keys(table).find(key => table[key] === column)!] === value,
  and: (...conditions: any[]) => (row: any, table: any) => conditions.filter(Boolean).every(condition => condition(row, table)),
  or: (...conditions: any[]) => (row: any, table: any) => conditions.filter(Boolean).some(condition => condition(row, table)),
}));

function installDatabase() {
  state.db.select.mockImplementation(fields => ({
    from: (table: any) => {
      const select = (predicate?: any, limit?: number) => (state.records[getTableName(table)] ?? [])
        .filter(row => !predicate || predicate(row, table)).slice(0, limit)
        .map(row => fields ? Object.fromEntries(Object.entries(fields).map(([alias, column]) =>
          [alias, row[Object.keys(table).find(key => table[key] === column)!]])) : { ...row });
      return { where: (predicate: any) => Promise.resolve(select(predicate)),
        limit: (limit: number) => Promise.resolve(select(undefined, limit)) };
    },
  }));
  state.db.insert.mockImplementation(table => ({
    values: (values: any) => {
      const insert = () => {
        const rows = state.records[getTableName(table)] ??= [];
        for (const value of Array.isArray(values) ? values : [values]) {
          if (value.chapterKey && rows.some(row => row.workId === value.workId && row.chapterKey === value.chapterKey)) continue;
          rows.push({ id: rows.length + 1, publishedAt: null, deliveryPending: false, ...value });
        }
      };
      return { then: (resolve: any) => { insert(); return Promise.resolve().then(resolve); },
        onConflictDoNothing: async () => { insert(); } };
    },
  }));
  state.db.update.mockImplementation(table => ({
    set: (values: any) => ({ where: async (predicate: any) => {
      for (const row of state.records[getTableName(table)] ?? []) if (predicate(row, table)) Object.assign(row, values);
    } }),
  }));
  state.db.transaction.mockImplementation(async operation => {
    const before = structuredClone(state.records);
    try { return await operation(state.db); }
    catch (error) { state.records = before; throw error; }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-not-a-real-token");
  const now = new Date();
  state.records = {
    monitor_config: [{ discordChannelId: "fake-channel" }],
    monitored_works: [{ id: 1, title: "Work", platform: "toptoon", listingUrl: "https://example.test/work",
      active: true, createdAt: now, lastCheckedAt: now }],
    detected_chapters: [{ id: 1, workId: 1, chapterKey: buildChapterKey("toptoon", "Work", "1"),
      chapterNumber: "1", thumbnailUrl: "https://example.test/1.png", publishedAt: null, deliveryPending: false }],
    monitor_history: [], monitor_activity: [],
  };
  installDatabase();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function installListing(numbers: string[]) {
  const image = await sharp({ create: { width: 800, height: 300, channels: 3, background: "#213547" } }).png().toBuffer();
  state.listing.mockImplementation(async () => ({
    candidates: numbers.map(number => ({ number, captureId: number,
      thumbnailUrl: `https://example.test/${number}.png`,
      releaseDate: new Date().toISOString().slice(0, 10) })),
    captureGroups: async (ids: string[]) => {
      const groups = [];
      for (let i = 0; i < ids.length; i += 3) groups.push({ chapterNumbers: ids.slice(i, i + 3), image });
      return groups;
    },
    close: async () => {},
  }));
}

describe("durable monitor delivery progress", () => {
  it.each([false, true])("recovers only the unsent group, even below a newer published chapter (%s)", async failFirst => {
    await installListing(["7", "6", "5", "4", "3", "2"]);
    const sent: string[] = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const payload = JSON.parse((options.body as FormData).get("payload_json") as string);
      sent.push(payload.content);
      call++;
      return new Response("temporary", { status: call === (failFirst ? 1 : 2) ? 503 : 200 });
    }));
    await runMonitor();
    const rows = state.records.detected_chapters;
    expect(rows.filter(row => row.deliveryPending)).toHaveLength(failFirst ? 6 : 3);
    expect(rows.filter(row => row.publishedAt)).toHaveLength(failFirst ? 0 : 3);
    expect(state.records.monitor_history).toHaveLength(failFirst ? 0 : 3);
    // A subsequent invocation sees persisted progress rather than process-local state.
    await runMonitor();
    expect(rows.filter(row => row.deliveryPending)).toHaveLength(0);
    expect(rows.filter(row => row.publishedAt)).toHaveLength(6);
    expect(state.records.monitor_history.map(row => row.chapterNumber).sort()).toEqual(["2", "3", "4", "5", "6", "7"]);
    if (!failFirst) {
      expect(sent[2]).toContain("capítulos 4, 3, 2");
      expect(sent[2]).not.toContain("capítulos 7");
    }
    expect(rows.find(row => row.chapterNumber === "1")?.publishedAt).toBeNull();
  });

  it("preserves the initial baseline without publishing old chapters", async () => {
    state.records.detected_chapters = [];
    state.records.monitored_works[0].lastCheckedAt = null;
    await installListing(["3", "2", "1"]);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await runMonitor();
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.records.detected_chapters).toHaveLength(3);
    expect(state.records.detected_chapters.every(row => !row.deliveryPending && row.publishedAt === null)).toBe(true);
  });
});