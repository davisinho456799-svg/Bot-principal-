import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const TARGET_CHAPTERS = ["28", "29", "30", "31", "32"];
const BACKFILL_STATUS = "Manual backfill TasteFolder 28-32";
const BACKFILL_LOCK = "panel-watch:tastefolder:28-32";

export function validateTargetRows(rows) {
  const byNumber = new Map(rows.map((row) => [String(row.chapter_number), row]));
  if (rows.length !== TARGET_CHAPTERS.length || TARGET_CHAPTERS.some((number) => !byNumber.has(number))) {
    throw new Error("Expected exactly the five TasteFolder chapters 28-32");
  }
  for (const number of TARGET_CHAPTERS) {
    const row = byNumber.get(number);
    if (row.published_at || row.delivery_pending) {
      throw new Error(`Chapter ${number} is not in the expected unsent state`);
    }
    if (typeof row.thumbnail_url !== "string" || !row.thumbnail_url.startsWith("https://")) {
      throw new Error(`Chapter ${number} has no safe HTTPS thumbnail`);
    }
  }
  return TARGET_CHAPTERS.map((number) => byNumber.get(number));
}

export function hasPriorTargetMessage(messages) {
  return messages.some((message) => {
    const content = String(message.content ?? "");
    if (!/\btastefolder\b/i.test(content)) return false;
    return TARGET_CHAPTERS.some((number) => new RegExp(`\\b${number}\\b`).test(content));
  });
}

export function buildPayload(rows) {
  const ordered = validateTargetRows(rows);
  return {
    content: `**TasteFolder** · 5 capítulos novos · capítulos ${TARGET_CHAPTERS.join(", ")}`,
    embeds: ordered.map((row) => ({
      title: `Capítulo ${row.chapter_number}`,
      image: { url: row.thumbnail_url },
    })),
  };
}

function readProcessEnvironment() {
  const entries = fs.readFileSync("/proc/1/environ", "utf8").split("\0");
  return Object.fromEntries(entries.flatMap((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)]] : [];
  }));
}

function loadPg() {
  const root = path.resolve("node_modules/.pnpm");
  const entry = fs.readdirSync(root).find((name) => name.startsWith("pg@"));
  if (!entry) throw new Error("Production PostgreSQL client is unavailable");
  const requireFromPg = createRequire(path.join(root, entry, "node_modules/pg/package.json"));
  return requireFromPg("pg");
}

async function discordRequest(url, token, options = {}, request = fetch) {
  const response = await request(url, {
    ...options,
    headers: { Authorization: `Bot ${token}`, ...options.headers },
    signal: AbortSignal.timeout(30_000),
  });
  return response;
}

async function verifyThumbnails(rows, request = fetch) {
  for (const row of rows) {
    const response = await request(row.thumbnail_url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PanelWatch/1.0)" },
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    await response.body?.cancel().catch(() => {});
    if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Chapter ${row.chapter_number} thumbnail could not be verified`);
    }
  }
}

async function readRecentDiscordMessages({ channelId, token, cutoff, request }) {
  const messages = [];
  let before = "";
  let reachedCutoff = false;
  for (let page = 0; page < 20; page += 1) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`;
    const response = await discordRequest(url, token, {}, request);
    if (!response.ok) throw new Error(`Discord history check failed with HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Discord history response was invalid");
    if (!batch.length) {
      reachedCutoff = true;
      break;
    }
    messages.push(...batch);
    const oldest = Number((BigInt(batch.at(-1).id) >> 22n) + 1420070400000n);
    if (batch.length < 100 || oldest < cutoff) {
      reachedCutoff = true;
      break;
    }
    before = batch.at(-1).id;
  }
  if (!reachedCutoff) throw new Error("Discord history scan limit reached; refusing to send without duplicate check");
  return messages;
}

export async function sendTasteFolderBackfill({ env = readProcessEnvironment(), request = fetch } = {}) {
  if (process.argv[2] !== "--send") throw new Error("Pass --send to authorize the one-time backfill");
  const databaseUrl = env.DATABASE_URL;
  const token = env.DISCORD_BOT_TOKEN;
  if (!databaseUrl || !token) throw new Error("Production database or Discord configuration is unavailable");

  const { Client } = loadPg();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let activityId;
  let messageId;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [BACKFILL_LOCK]);
    await client.query("BEGIN READ ONLY");
    const workResult = await client.query(
      "SELECT id, title FROM monitored_works WHERE title = $1 AND platform = $2 AND active = true",
      ["TasteFolder", "toptoon"],
    );
    if (workResult.rowCount !== 1) throw new Error("TasteFolder is not uniquely active in production");
    const work = workResult.rows[0];
    const configResult = await client.query(
      "SELECT discord_channel_id FROM monitor_config WHERE discord_channel_id IS NOT NULL LIMIT 1",
    );
    const channelId = configResult.rows[0]?.discord_channel_id;
    if (!/^\d{17,20}$/.test(String(channelId ?? ""))) throw new Error("The production Discord destination is unavailable");
    const chaptersResult = await client.query(
      "SELECT chapter_number, thumbnail_url, published_at, delivery_pending, detected_at FROM detected_chapters WHERE work_id = $1 AND chapter_number = ANY($2::text[])",
      [work.id, TARGET_CHAPTERS],
    );
    const rows = validateTargetRows(chaptersResult.rows);
    const cutoff = Math.min(...rows.map((row) => new Date(row.detected_at).getTime())) - 24 * 60 * 60 * 1000;
    const priorBackfill = await client.query(
      "SELECT id FROM monitor_activity WHERE work_id = $1 AND status LIKE $2 LIMIT 1",
      [work.id, `${BACKFILL_STATUS}%`],
    );
    if (priorBackfill.rowCount) throw new Error("A prior backfill attempt exists; refusing to risk duplicate delivery");
    await client.query("COMMIT");

    const recentMessages = await readRecentDiscordMessages({ channelId, token, cutoff, request });
    if (hasPriorTargetMessage(recentMessages)) throw new Error("A matching TasteFolder message already exists in recent Discord history");
    await verifyThumbnails(rows, request);

    await client.query("BEGIN");
    const lockedRows = await client.query(
      "SELECT chapter_number, thumbnail_url, published_at, delivery_pending FROM detected_chapters WHERE work_id = $1 AND chapter_number = ANY($2::text[]) FOR UPDATE",
      [work.id, TARGET_CHAPTERS],
    );
    validateTargetRows(lockedRows.rows);
    const marker = await client.query(
      "INSERT INTO monitor_activity (work_id, chapter_count, status) VALUES ($1, $2, $3) RETURNING id",
      [work.id, TARGET_CHAPTERS.length, `${BACKFILL_STATUS} started`],
    );
    activityId = marker.rows[0].id;
    await client.query("COMMIT");

    const delivery = await request(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(lockedRows.rows)),
      signal: AbortSignal.timeout(45_000),
    });
    if (!delivery.ok) throw new Error(`Discord did not confirm delivery (HTTP ${delivery.status})`);
    const acknowledgement = await delivery.json();
    messageId = acknowledgement.id;
    if (!/^\d{17,20}$/.test(String(messageId ?? ""))) {
      throw new Error("Discord accepted the post but returned no verifiable message ID; do not retry");
    }

    await client.query("BEGIN");
    const publishedAt = new Date();
    const updated = await client.query(
      "UPDATE detected_chapters SET published_at = $1, delivery_pending = false WHERE work_id = $2 AND chapter_number = ANY($3::text[]) AND published_at IS NULL RETURNING chapter_number",
      [publishedAt, work.id, TARGET_CHAPTERS],
    );
    if (updated.rowCount !== TARGET_CHAPTERS.length) {
      throw new Error("Discord accepted the post but the history update was incomplete; do not retry");
    }
    await client.query(
      "UPDATE monitor_activity SET status = $1 WHERE id = $2",
      [`${BACKFILL_STATUS} published; Discord message ${messageId}`, activityId],
    );
    await client.query(
      "UPDATE monitored_works SET last_published_at = $1, last_status = $2, updated_at = $1 WHERE id = $3",
      [publishedAt, "5 new chapters published (manual backfill)", work.id],
    );
    await client.query("COMMIT");
    return { posted: TARGET_CHAPTERS, messageId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (activityId && !messageId) {
      await client.query(
        "UPDATE monitor_activity SET status = $1 WHERE id = $2",
        [`${BACKFILL_STATUS} requires review; no automatic retry`, activityId],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [BACKFILL_LOCK]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  sendTasteFolderBackfill()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ backfillFailed: true, message: error.message }));
      process.exitCode = 1;
    });
}
