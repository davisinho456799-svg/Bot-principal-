import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startWorker } from "./worker-startup.mjs";
import { createMonitorPreparation, PACKAGE_TIMEOUT_MS, BROWSER_TIMEOUT_MS } from "./worker-monitor-runtime.mjs";
import { validatePublication, productionPath } from "./discloud-publication.mjs";
import { createDeploymentJournal, deployDiscloud } from "./discloud-deploy.mjs";

const revision = "a".repeat(40);
const history = { phase: async (name, action) => action(), record: async () => {} };
test("worker loads before optional recovery and does not wait for it", async () => {
  const sequence = [];
  let complete;
  const optional = new Promise(resolve => { complete = resolve; });
  const result = await startWorker({
    history, validate: async () => sequence.push("validate"), load: async () => sequence.push("load"),
    prepare: async () => { sequence.push("optional"); await optional; },
  });
  assert.deepEqual(sequence, ["validate", "load", "optional"]);
  complete();
  await result.optional;
});
test("optional network failure is handled without stopping Discord", async () => {
  let loaded = false;
  const events = [];
  const result = await startWorker({
    history: { ...history, record: async e => events.push(e) }, validate: async () => {},
    load: async () => { loaded = true; }, prepare: async () => { throw Object.assign(new Error("private-token"), { code: "ETIMEDOUT" }); },
    warn: () => {},
  });
  await result.optional;
  assert.equal(loaded, true);
  assert.equal(events[0].status, "degraded");
  assert.equal(JSON.stringify(events).includes("private-token"), false);
});
test("invalid required compilation prevents loading any old worker", async () => {
  let loaded = false;
  await assert.rejects(startWorker({ history, validate: async () => { throw new Error("invalid compilation"); },
    load: async () => { loaded = true; }, prepare: async () => {} }), /invalid compilation/);
  assert.equal(loaded, false);
});
test("missing optional packages have bounded recovery and do not expose command output", async () => {
  const calls = [], events = [];
  await createMonitorPreparation({
    root: "/fixture", env: {},
    canAccess: async () => { throw new Error("not installed"); },
    history: { record: async e => events.push(e) },
    command: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      throw Object.assign(new Error("private-command-url"), { code: "ETIMEDOUT", stderr: "private-password" });
    },
  })();
  assert.equal(calls[0].options.timeout, PACKAGE_TIMEOUT_MS);
  assert.equal(calls[0].options.killSignal, "SIGKILL");
  assert.equal(calls[0].options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  assert.equal(events[1].status, "degraded");
  assert.equal(JSON.stringify(events).includes("private-password"), false);
});
test("managed browser reuse avoids an unnecessary download", async () => {
  let commands = 0;
  await createMonitorPreparation({
    root: "/fixture", env: {}, history,
    canAccess: async p => { if (p.endsWith("package.json") || p === "/managed/chrome") return; throw new Error("missing"); },
    loadModule: async () => ({ chromium: { executablePath: () => "/managed/chrome" } }),
    command: async () => { commands++; throw new Error("no system browser"); },
  })();
  assert.equal(commands, 1); // Only PATH discovery, no Playwright install.
});
test("browser download has its own hard timeout and clears the skip flag", async () => {
  let browserOptions;
  await createMonitorPreparation({
    root: "/fixture", env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" }, history,
    canAccess: async p => { if (p.endsWith("package.json")) return; throw new Error("missing"); },
    loadModule: async () => { throw new Error("no managed browser"); },
    command: async (cmd, args, options) => {
      if (cmd === "sh") throw new Error("no system browser");
      browserOptions = options;
    },
  })();
  assert.equal(browserOptions.timeout, BROWSER_TIMEOUT_MS);
  assert.equal(browserOptions.killSignal, "SIGKILL");
  assert.equal(browserOptions.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, undefined);
});

const base = { version: 1, revision, files: { "main.js": "original", "discloud.config": "live" } };
test("publication rejects a changed remote branch before any write", () => {
  assert.throws(() => validatePublication({ base, remoteRevision: "b".repeat(40), localHashes: base.files, paths: ["main.js"], approved: true }), /branch changed/);
});
test("publication rejects unlisted stale source or production configuration", () => {
  assert.throws(() => validatePublication({ base, remoteRevision: revision, localHashes: { "main.js": "new", "discloud.config": "stale" }, paths: ["main.js"], approved: true }), /Unlisted production differences/);
});
test("publication requires an aligned baseline and explicit approval", () => {
  assert.throws(() => validatePublication({ base: null, remoteRevision: revision, localHashes: {}, paths: ["main.js"], approved: true }), /baseline/);
  assert.throws(() => validatePublication({ base, remoteRevision: revision, localHashes: { ...base.files, "main.js": "new" }, paths: ["main.js"] }), /approval/);
});
test("targeted publication allows additions and deletions without a force push", () => {
  const paths = ["main.js", "scripts/new.mjs"];
  assert.deepEqual(validatePublication({ base, remoteRevision: revision, localHashes: { "discloud.config": "live", "scripts/new.mjs": "new" }, paths, approved: true }), paths);
});
test("generated output, logs and secrets cannot be publication source", () => {
  for (const name of ["artifacts/api-server/.build-history/a.jsonl", "artifacts/api-server/.build-stage-abc/previous/index.mjs",
    "scripts/.env.production", "../main.js", "lib/a.pem", "artifacts/api-server/compiled-worker/index.mjs"]) {
    assert.equal(productionPath(name), false);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "deployment-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "main.js"), 'process.env.MONITOR_INTERVAL_MINUTES ??= "60";process.env.EMBED_MONITOR_INTERVAL_HOURS ??= "24";');
  const filename = path.join(root, "journal.json");
  return { root, filename, journal: createDeploymentJournal({ revision, filename, output: () => {} }) };
}
test("actual deployment CLI accepts omitted options and records preflight failure", async t => {
  const f = await fixture(t);
  let result;
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./discloud-deploy.mjs", import.meta.url))], {
      cwd: f.root, env: { ...process.env, GITHUB_SHA: revision, DISCLOUD_TOKEN: "" }, timeout: 10000,
    });
    assert.fail("Missing credentials must fail before contacting the provider");
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  assert.equal(result.stderr.includes('"errorName":"TypeError"'), false);
  assert.equal(result.stdout.includes('"phase":"verify.environment","status":"failed"'), true);
  assert.equal(result.stderr.includes('"event":"deployment_failed"'), true);
});
test("journal survives recreation and filters sensitive fields and other revisions", async t => {
  const f = await fixture(t);
  f.journal.record({ phase: "package.source", status: "completed", token: "private-token" });
  const next = createDeploymentJournal({ revision, filename: f.filename, output: () => {} });
  const event = { event: "worker_build", revision, phase: "compile.bundle", status: "completed", password: "private-password" };
  next.collect([event, event, { ...event, revision: "b".repeat(40) }]);
  next.finish("success");
  const result = JSON.parse(await readFile(f.filename, "utf8"));
  assert.equal(result.events.length, 2);
  assert.equal(result.outcome, "success");
  assert.equal(JSON.stringify(result).includes("private-"), false);
});
test("invalid revision cannot be persisted as a diagnostic secret", () => {
  assert.throws(() => createDeploymentJournal({ revision: "postgres://private-password" }), /valid public revision/);
});

function provider({ failure, staleBuild = false, changedDatabase = false } = {}) {
  let commits = 0, probes = 0, clock = 0;
  const commands = [];
  const request = async (url, options) => {
    const endpoint = url.split("/1790572666269")[1];
    let body = { status: "ok" }, status = 200;
    if (endpoint === "/exec") {
      const cmd = JSON.parse(options.body).cmd;
      const encoded = cmd.match(/Buffer\.from\("([^"]+)"/)[1];
      const code = Buffer.from(encoded, "base64").toString();
      new Script(code); // Validate the exact scripts sent to Discloud.
      commands.push(code);
      if (code.includes("/proc/1/environ")) {
        probes++;
        body.exec = { stdout: JSON.stringify({ revision, databaseConfigured: true, databaseIsNeon: false, databaseHostDigest: changedDatabase && probes > 1 ? "different" : "same",
          discordTokenConfigured: true, imageMinutes: 60, embedHours: 24, workerBuildCurrent: !staleBuild }) };
      } else body.exec = { stdout: "[]" };
    }
    if (endpoint === "/status") body.apps = { startedAt: commits ? "2026-10-03T16:55:00Z" : "2026-10-03T16:00:00Z" };
    if (endpoint === "") body.apps = { online: true };
    if (endpoint === "/logs") body.apps = { terminal: { big: '2026-10-03T16:55:01Z {"time":1791046501000,"msg":"ClientReady foi recebido"}' } };
    if (endpoint === "/commit") {
      commits++;
      if (failure === "ambiguous") throw Object.assign(new Error("private-provider-output"), { name: "TimeoutError" });
      if (failure === "rejected") {
        status = 400;
        body = { status: "error", logs: 'compiler private-token\n{"event":"worker_build","revision":"' + revision + '","phase":"activate.outputs","status":"failed","code":"EXDEV","password":"private-password"}' };
      }
    }
    return { ok: status === 200, status, json: async () => body };
  };
  return { request, wait: async ms => { clock += ms; }, now: () => clock, commits: () => commits, commands };
}
async function deployment(t, settings) {
  const f = await fixture(t), p = provider(settings);
  // The real archive is supplied by the workflow; the mock never inspects its data.
  await writeFile("/tmp/discloud-upload.zip", "fixture");
  return { ...f, p, run: () => deployDiscloud({ ...f, token: "fixture-token", revision, request: p.request, wait: p.wait, now: p.now, verificationTimeout: 30_000 }) };
}
test("automatic deployment verifies restart, build, Discord and saves successful history", async t => {
  const f = await deployment(t);
  await f.run();
  assert.equal(f.p.commits(), 1);
  assert.equal(JSON.parse(await readFile(f.filename, "utf8")).outcome, "success");
});
test("ambiguous upload is never resent and can still be verified", async t => {
  const f = await deployment(t, { failure: "ambiguous" });
  await f.run();
  assert.equal(f.p.commits(), 1);
});
test("definite provider failure retains safe diagnostics without exposing raw logs", async t => {
  const f = await deployment(t, { failure: "rejected" });
  await assert.rejects(f.run(), /HTTP 400/);
  const saved = await readFile(f.filename, "utf8");
  assert.equal(saved.includes("EXDEV"), true);
  assert.equal(saved.includes("private-"), false);
  assert.equal(JSON.parse(saved).outcome, "failed");
});
test("a stale compiled worker cannot produce a successful deployment", async t => {
  const f = await deployment(t, { staleBuild: true });
  await assert.rejects(f.run(), /Timed out/);
  assert.equal(JSON.parse(await readFile(f.filename, "utf8")).outcome, "failed");
});
test("production database change fails closed rather than retrying as startup delay", async t => {
  const f = await deployment(t, { changedDatabase: true });
  await assert.rejects(f.run(), /safety check/);
});