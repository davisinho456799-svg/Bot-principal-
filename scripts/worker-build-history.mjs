import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

/** Log only allowlisted diagnostic fields, never command output or environment values. */
export function safeBuildEvent(event) {
  const output = {};
  for (const key of ["event", "runId", "revision", "kind", "at", "phase", "status", "artifact", "code", "errorName"]) {
    if (typeof event[key] === "string" && /^[\w.:\-TZ]+$/.test(event[key]) && event[key].length <= 100) {
      output[key] = event[key];
    }
  }
  for (const key of ["durationMs", "exitCode"]) {
    if (Number.isFinite(event[key])) output[key] = event[key];
  }
  return output;
}

export function extractBuildEvents(logs) {
  const text = typeof logs === "string" ? logs : Array.isArray(logs) ? logs.join("\n") :
    Object.values(logs ?? {}).filter(value => typeof value === "string").join("\n");
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{"event":"worker_build"');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start));
      if (parsed.event === "worker_build") events.push(safeBuildEvent(parsed));
    } catch { /* Build output can contain non-JSON compiler diagnostics. */ }
  }
  return events;
}

export async function createBuildHistory(root, { kind = "build", output = line => console.log(line), keep = 20 } = {}) {
  const runId = randomUUID();
  const directory = path.join(root, "artifacts/api-server/.build-history");
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${runId}.jsonl`;
  let revision;
  try {
    const candidate = (await readFile(path.join(root, "deploy-revision.txt"), "utf8")).trim();
    if (/^[a-f0-9]{40}$/.test(candidate)) revision = candidate;
  } catch (error) { if (error.code !== "ENOENT") console.warn("Build revision could not be read"); }
  let persistent = true;
  const phaseStarts = new Map();
  try {
    await mkdir(directory, { recursive: true });
    const histories = (await readdir(directory)).filter(name => /^\d{4}-.*\.jsonl$/.test(name)).sort();
    for (const old of histories.slice(0, Math.max(0, histories.length - Math.max(1, keep) + 1))) {
      await rm(path.join(directory, old));
    }
  } catch {
    persistent = false;
    console.warn("Build history storage unavailable; structured console history remains enabled");
  }
  async function record(event) {
    if (event.status === "started") phaseStarts.set(event.phase, performance.now());
    if (["completed", "failed", "degraded"].includes(event.status) && phaseStarts.has(event.phase)) {
      event = { ...event, durationMs: event.durationMs ?? Math.round(performance.now() - phaseStarts.get(event.phase)) };
      phaseStarts.delete(event.phase);
    }
    const { event: eventName, ...details } = safeBuildEvent({
      ...event, event: "worker_build", runId, revision, kind, at: new Date().toISOString(),
    });
    const line = JSON.stringify({ event: eventName, ...details });
    output(line);
    if (persistent) {
      try { await appendFile(path.join(directory, filename), line + "\n", { mode: 0o600 }); }
      catch {
        persistent = false;
        console.warn("Build history could not be saved; structured console history remains enabled");
      }
    }
  }
  async function phase(name, operation) {
    const started = performance.now();
    await record({ phase: name, status: "started" });
    try {
      const result = await operation();
      await record({ phase: name, status: "completed", durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      await record({
        phase: name, status: "failed", durationMs: Math.round(performance.now() - started),
        code: error.code, errorName: error.name,
        exitCode: Number.isFinite(error.code) ? error.code : error.status,
      });
      throw error;
    }
  }
  return { runId, record, phase };
}