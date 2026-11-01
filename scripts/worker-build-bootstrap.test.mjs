import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rebuildWorker, removeRetiredWorkerSources } from "./worker-build-bootstrap.mjs";
import { ensureCurrentWorker, getBuildFingerprint, writeBuildManifest } from "./worker-build-provenance.mjs";
import { startWorker } from "./worker-startup.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "worker-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "artifacts/api-server/src/bot/commands", "artifacts/api-server/compiled-worker/node_modules",
    "lib/db/src", "scripts", "saved-data",
  ]) await mkdir(path.join(root, directory), { recursive: true });
  for (const name of [
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "artifacts/api-server/build.mjs", "artifacts/api-server/package.json",
    "lib/db/package.json",
  ]) await writeFile(path.join(root, name), "{}");
  const source = path.join(root, "artifacts/api-server/src/index.ts");
  const bundle = path.join(root, "artifacts/api-server/compiled-worker/index.mjs");
  await writeFile(source, "export const version = 1;");
  await writeFile(bundle, "original executable");
  const build = async () => {
    await writeFile(bundle, "current executable");
    await writeBuildManifest(root, path.dirname(bundle), await getBuildFingerprint(root));
  };
  return { root, source, bundle, build };
}

const history = { phase: async (_name, action) => action(), record: async () => {} };
const execute = promisify(execFile);

async function cliFixture(t, { failInstall = false } = {}) {
  const f = await fixture(t);
  await cp(new URL("../main.js", import.meta.url), path.join(f.root, "main.js"));
  for (const name of [
    "worker-build-bootstrap.mjs", "worker-build-provenance.mjs", "worker-build-history.mjs",
    "worker-startup.mjs", "worker-monitor-runtime.mjs",
  ]) await cp(new URL(name, import.meta.url), path.join(f.root, "scripts", name));
  const bin = path.join(f.root, "fake-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "corepack"), `#!${process.execPath}
require("node:fs").appendFileSync("installation-marker", JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(${failInstall ? 1 : 0});
`, { mode: 0o755 });
  await writeFile(path.join(f.root, "artifacts/api-server/build.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
import { getBuildFingerprint, writeBuildManifest } from "../../scripts/worker-build-provenance.mjs";
const installed = JSON.parse((await readFile("installation-marker", "utf8")).split("\\n")[0]);
if (JSON.stringify(installed) !== JSON.stringify(["pnpm", "install", "--frozen-lockfile", "--prod=false"])) throw new Error("Build started without prerequisites");
await writeFile("artifacts/api-server/compiled-worker/index.mjs", 'import fs from "node:fs"; fs.writeFileSync("worker-loaded", "current");');
await writeBuildManifest(process.cwd(), "artifacts/api-server/compiled-worker", await getBuildFingerprint(process.cwd()));
`);
  f.options = {
    cwd: f.root,
    env: { PATH: bin + path.delimiter + process.env.PATH, NODE_ENV: "production" },
    timeout: 10000,
  };
  return f;
}

test("the real entrypoint restores prerequisites, validates the rebuild, then loads the worker", async t => {
  const f = await cliFixture(t);
  const { stdout } = await execute(process.execPath, ["main.js"], f.options);
  assert.equal(await readFile(path.join(f.root, "worker-loaded"), "utf8"), "current");
  assert.match(stdout, /"phase":"prepare.build-dependencies","status":"completed"/);
  assert.match(stdout, /"phase":"load.worker-module","status":"completed"/);
});

test("the real entrypoint exits safely when installation fails and never loads the stale worker", async t => {
  const f = await cliFixture(t, { failInstall: true });
  await assert.rejects(execute(process.execPath, ["main.js"], f.options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /"phase":"prepare.build-dependencies","status":"failed"/);
    return true;
  });
  await assert.rejects(readFile(path.join(f.root, "worker-loaded")), { code: "ENOENT" });
  assert.equal(await readFile(f.bundle, "utf8"), "original executable");
});

test("overlaid retired sources are removed without deleting data or active commands", async t => {
  const f = await fixture(t);
  const files = {
    "artifacts/api-server/src/bot/commands/filme.ts": "retired command",
    "artifacts/api-server/src/bot/tmdb.ts": "retired integration",
    "artifacts/api-server/src/bot/commands/identificar.ts": "active command",
    "saved-data/history.json": "historical filme records",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(f.root, name), content);
  await removeRetiredWorkerSources(f.root);
  for (const name of Object.keys(files).slice(0, 2)) {
    await assert.rejects(readFile(path.join(f.root, name)), { code: "ENOENT" });
  }
  for (const name of Object.keys(files).slice(2)) {
    assert.equal(await readFile(path.join(f.root, name), "utf8"), files[name]);
  }
});

test("cleanup tolerates already absent retired sources", async t => {
  const f = await fixture(t);
  await removeRetiredWorkerSources(f.root);
  await removeRetiredWorkerSources(f.root);
});

test("cleanup unlinks a retired file symlink without removing its target", async t => {
  const f = await fixture(t);
  const target = path.join(f.root, "saved-data/history.json");
  await writeFile(target, "keep this data");
  const link = path.join(f.root, "artifacts/api-server/src/bot/tmdb.ts");
  await symlink(target, link);
  await removeRetiredWorkerSources(f.root);
  assert.equal(await readFile(target, "utf8"), "keep this data");
  await assert.rejects(lstat(link), { code: "ENOENT" });
});

test("cleanup refuses recursive deletion of unexpected directories", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "artifacts/api-server/src/bot/tmdb.ts");
  await mkdir(directory);
  await writeFile(path.join(directory, "important.txt"), "keep");
  await assert.rejects(removeRetiredWorkerSources(f.root));
  assert.equal(await readFile(path.join(directory, "important.txt"), "utf8"), "keep");
});

test("dependency installation finishes before the build and does not change the lockfile", async t => {
  const f = await fixture(t);
  const phases = [];
  const calls = [];
  const result = await rebuildWorker(f.root, {
    env: { TEST_MARKER: "preserve", NODE_ENV: "production" },
    history: { phase: async (name, action) => { phases.push(name); return action(); } },
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
        phases.push("installation-finished");
      } else {
        assert.ok(phases.includes("installation-finished"));
      }
      return { stdout: "safe build output" };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "corepack");
  assert.deepEqual(calls[0].args, ["pnpm", "install", "--frozen-lockfile", "--prod=false"]);
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, [path.join(f.root, "artifacts/api-server/build.mjs")]);
  assert.equal(calls[0].options.env.CI, "true");
  assert.equal(calls[0].options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  assert.equal(calls[0].options.env.TEST_MARKER, "preserve");
  assert.equal(calls[0].options.cwd, f.root);
  assert.equal(calls[0].options.env.NODE_ENV, calls[1].options.env.NODE_ENV);
  assert.equal(await readFile(path.join(f.root, "pnpm-lock.yaml"), "utf8"), "{}");
  assert.equal(result.stdout, "safe build output");
});

test("a valid unchanged compilation does not install or rebuild", async t => {
  const f = await fixture(t);
  await f.build();
  const result = await ensureCurrentWorker(f.root, () => rebuildWorker(f.root, {
    run: async () => assert.fail("unexpected package installation"),
  }));
  assert.equal(result.rebuilt, false);
});

test("source changes restore build dependencies and produce a validated new worker", async t => {
  const f = await fixture(t);
  await f.build();
  await writeFile(f.source, "export const version = 2;");
  let calls = 0;
  const result = await ensureCurrentWorker(f.root, () => rebuildWorker(f.root, {
    run: async () => {
      calls++;
      if (calls === 2) await f.build();
      return { stdout: "" };
    },
  }));
  assert.equal(calls, 2);
  assert.equal(result.valid, true);
  assert.equal(result.rebuilt, true);
});

test("failed dependency installation neither builds nor loads a stale executable", async t => {
  const f = await fixture(t);
  let calls = 0;
  let loaded = false;
  let prepared = false;
  await assert.rejects(startWorker({
    history,
    validate: () => ensureCurrentWorker(f.root, () => rebuildWorker(f.root, {
      run: async () => { calls++; throw Object.assign(new Error("install failed"), { code: 1 }); },
    })),
    load: async () => { loaded = true; },
    prepare: async () => { prepared = true; },
  }), /install failed/);
  assert.equal(calls, 1);
  assert.equal(loaded, false);
  assert.equal(prepared, false);
  assert.equal(await readFile(f.bundle, "utf8"), "original executable");
});

test("failed compilation keeps the previous executable and rejects startup", async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(rebuildWorker(f.root, {
    run: async () => {
      if (++calls === 2) throw new Error("build failed");
      return { stdout: "" };
    },
  }), /build failed/);
  assert.equal(calls, 2);
  assert.equal(await readFile(f.bundle, "utf8"), "original executable");
});