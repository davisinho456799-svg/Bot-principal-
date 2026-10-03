import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { extractBuildEvents, safeBuildEvent } from "./worker-build-history.mjs";

export function createDeploymentJournal({ revision, filename = "/tmp/discloud-deploy-history.json", output = console.log }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("A valid public revision is required for deployment diagnostics");
  let document = { version: 1, revision, outcome: "running", events: [] };
  if (fs.existsSync(filename)) {
    const previous = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (previous.version === 1 && previous.revision === revision && Array.isArray(previous.events)) {
      document.events = previous.events.slice(-5000).map(safeBuildEvent);
    }
  }
  const runId = randomUUID();
  const seen = new Set(document.events.map(event => JSON.stringify(event)));
  function save() { fs.writeFileSync(filename, JSON.stringify(document, null, 2), { mode: 0o600 }); }
  function record(event) {
    const started = [...document.events].reverse().find(e => e.kind === "deploy" && e.phase === event.phase && e.status === "started");
    const durationMs = event.durationMs ?? (event.status === "completed" && started ? Math.max(0, Date.now() - Date.parse(started.at)) : undefined);
    const safe = safeBuildEvent({ ...event, durationMs, event: "worker_build", runId, revision, kind: "deploy", at: new Date().toISOString() });
    document.events.push(safe);
    output(JSON.stringify(safe));
    save();
  }
  function collect(events) {
    for (const event of events) {
      const safe = safeBuildEvent(event);
      const key = JSON.stringify(safe);
      if (safe.revision === revision && !seen.has(key) && document.events.length < 5000) {
        document.events.push(safe);
        seen.add(key);
      }
    }
    save();
  }
  async function phase(name, action) {
    const started = performance.now();
    record({ phase: name, status: "started" });
    try {
      const result = await action();
      record({ phase: name, status: "completed", durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      record({ phase: name, status: "failed", durationMs: Math.round(performance.now() - started), code: error.code, errorName: error.name });
      throw error;
    }
  }
  function finish(outcome) { document.outcome = outcome; save(); }
  save();
  return { record, collect, phase, finish };
}

export async function deployDiscloud({
  root = process.cwd(), token = process.env.DISCLOUD_TOKEN, revision = process.env.GITHUB_SHA,
  request = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  journal = createDeploymentJournal({ revision }), verificationTimeout = 600_000,
} = {}) {
  const base = "https://api.discloud.app/v2/app/1790572666269";
  async function api(endpoint, options = {}, timeout = 45000) {
    const response = await request(base + endpoint, {
      ...options, headers: { "api-token": token, ...options.headers }, signal: AbortSignal.timeout(timeout),
    });
    let body;
    try { body = await response.json(); }
    catch {
      const error = new Error(`Discloud ${endpoint || "/info"} returned non-JSON HTTP ${response.status}`);
      error.httpStatus = response.status;
      error.code = `NON_JSON_HTTP_${response.status}`;
      error.ambiguousResponse = response.ok;
      throw error;
    }
    journal.collect(extractBuildEvents(body.logs));
    if (!response.ok || body.status === "error") {
      const error = new Error(`Discloud ${endpoint || "/info"} failed HTTP ${response.status}`);
      error.httpStatus = response.status;
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    return body;
  }
  const app = body => Array.isArray(body.apps) ? body.apps[0] : body.apps;
  const probeCode = `(async()=> {
    const fs=require("node:fs"),crypto=require("node:crypto");
    const env={};
    for(const item of fs.readFileSync("/proc/1/environ","utf8").split("\\0")) {
      const i=item.indexOf("="); if(i>0)env[item.slice(0,i)]=item.slice(i+1);
    }
    const main=fs.readFileSync("main.js","utf8");
    const fallback=name=>main.match(new RegExp(name+'\\\\s*\\\\?\\\\?=\\\\s*"(\\\\d+)"'))?.[1];
    const host=env.DATABASE_URL?new URL(env.DATABASE_URL).hostname:"";
    process.env.NODE_ENV=env.NODE_ENV||"production";
    const helper=await import(require("node:url").pathToFileURL(require("node:path").resolve("scripts/worker-build-provenance.mjs")).href);
    console.log(JSON.stringify({
      revision:fs.readFileSync("deploy-revision.txt","utf8").trim(),
      databaseConfigured:!!host, databaseIsNeon:/(^|\\.)neon\\.tech$/i.test(host),
      databaseHostDigest:host?crypto.createHash("sha256").update(host).digest("hex"):null,
      discordTokenConfigured:!!env.DISCORD_BOT_TOKEN,
      imageMinutes:Number(env.MONITOR_INTERVAL_MINUTES||fallback("MONITOR_INTERVAL_MINUTES")),
      embedHours:Number(env.EMBED_MONITOR_INTERVAL_HOURS||fallback("EMBED_MONITOR_INTERVAL_HOURS")),
      workerBuildCurrent:(await helper.inspectWorkerBuild(process.cwd())).valid
    }));
  })().catch(()=>{console.log(JSON.stringify({probeFailed:true}));process.exitCode=1;});`;
  const encodedCommand = code => `node -e 'eval(Buffer.from("${Buffer.from(code).toString("base64")}","base64").toString())'`;
  async function execute(code) {
    const result = await api("/exec", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: encodedCommand(code) }) });
    return JSON.parse(result.exec.stdout.trim());
  }
  let credentialsValidated = false;
  try {
    const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
    const imageMinutes = Number(main.match(/MONITOR_INTERVAL_MINUTES\s*\?\?=\s*"(\d+)"/)?.[1]);
    const embedHours = Number(main.match(/EMBED_MONITOR_INTERVAL_HOURS\s*\?\?=\s*"(\d+)"/)?.[1]);
    const before = await journal.phase("verify.environment", async () => {
      if (!token || !/^[a-f0-9]{40}$/.test(revision ?? "") || !imageMinutes || !embedHours) throw new Error("Deployment configuration is incomplete");
      const result = await execute(probeCode);
      if (!result.databaseConfigured || result.databaseIsNeon || !result.discordTokenConfigured) throw new Error("Existing environment failed safety checks");
      return result;
    });
    credentialsValidated = true;
    const oldStart = app(await api("/status")).startedAt;
    await journal.phase("upload.archive", async () => {
      const archive = new FormData();
      archive.append("file", new Blob([fs.readFileSync("/tmp/discloud-upload.zip")]), "bot.zip");
      try { await api("/commit", { method: "PUT", body: archive }, 600000); }
      catch (error) {
        const uncertain = error.ambiguousResponse || error.httpStatus >= 500 || error.httpStatus === 408 ||
          ["TimeoutError", "AbortError", "TypeError"].includes(error.name);
        if (!uncertain) throw error;
        journal.record({ phase: "upload.archive", status: "interrupted", errorName: error.name });
        // Never resend an ambiguous upload. Verify the accepted revision.
      }
    });
    await journal.phase("verify.running-worker", async () => {
      const deadline = now() + verificationTimeout;
      while (now() < deadline) {
        await wait(15000);
        try {
          const [info, status] = await Promise.all([api(""), api("/status")]);
          if (!app(info)?.online || app(status)?.startedAt === oldStart) continue;
          const running = await execute(probeCode);
          if (running.revision !== revision || !running.workerBuildCurrent) continue;
          if (!running.databaseConfigured || running.databaseIsNeon || running.databaseHostDigest !== before.databaseHostDigest ||
              !running.discordTokenConfigured || running.imageMinutes !== imageMinutes || running.embedHours !== embedHours) {
            throw Object.assign(new Error("Runtime safety check failed"), { code: "SAFETY_CHECK_FAILED" });
          }
          const terminal = app(await api("/logs"))?.terminal;
          const text = terminal?.big || terminal?.small || "";
          journal.collect(extractBuildEvents(text));
          const startedAt = Date.parse(app(status).startedAt);
          const ready = text.split(/\r?\n/).some(line => {
            if (!line.includes("ClientReady foi recebido")) return false;
            const timestamp = line.match(/"time":(\d{13})/);
            return (timestamp ? Number(timestamp[1]) : Date.parse(line.split(/\s/)[0])) >= startedAt;
          });
          if (ready) return;
        } catch (error) { if (error.code === "SAFETY_CHECK_FAILED") throw error; }
      }
      throw Object.assign(new Error("Timed out verifying the current worker"), { code: "RUNTIME_VERIFICATION_TIMEOUT" });
    });
    journal.finish("success");
  } catch (error) {
    journal.finish("failed");
    throw error;
  } finally {
    if (credentialsValidated) {
      try {
        const events = await execute(`const fs=require("node:fs"),p=require("node:path");const dir="artifacts/api-server/.build-history";const events=[];if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(n=>n.endsWith(".jsonl")).sort().slice(-20)){for(const line of fs.readFileSync(p.join(dir,name),"utf8").split("\\n"))try{const e=JSON.parse(line);if(e.revision==="${revision}")events.push(e);}catch{}}console.log(JSON.stringify(events.slice(-2000)));`);
        journal.collect(events);
      } catch (error) { journal.record({ phase: "collect.runtime-history", status: "unavailable", errorName: error.name }); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  deployDiscloud().catch(error => {
    console.error(JSON.stringify(safeBuildEvent({ event: "deployment_failed", code: error.code, errorName: error.name })));
    process.exitCode = 1;
  });
}