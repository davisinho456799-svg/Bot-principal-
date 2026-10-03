import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  ensureCurrentWorker, getBuildFingerprint, inspectWorkerBuild,
  promoteBuildArtifacts, writeBuildManifest,
} from "./worker-build-provenance.mjs";
import { createBuildRequire, getBuildTransports, rebasePinoWorkers } from "./worker-build-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "worker-provenance-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "artifacts/api-server/src/index.ts");
  const worker = path.join(root, "artifacts/api-server/compiled-worker");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.join(root, "lib/db/src"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "artifacts/api-server/package.json", "artifacts/api-server/build.mjs", "lib/db/package.json"]) {
    await writeFile(path.join(root, name), "{}");
  }
  await writeFile(source, "export const value = 1;");
  await writeFile(path.join(root, "lib/db/src/index.ts"), "export const db = {};");
  async function build() {
    await mkdir(path.join(worker, "node_modules"), { recursive: true });
    await writeFile(path.join(worker, "index.mjs"), "export const worker = 'current';");
    await writeFile(path.join(worker, "thread-stream-worker.mjs"), "export const workerPath = 'current';");
    await writeBuildManifest(root, worker, await getBuildFingerprint(root));
  }
  return { root, source, worker, build };
}

test("a valid worker is reused without rebuilding", async t => {
  const f = await fixture(t);
  await f.build();
  const result = await ensureCurrentWorker(f.root, () => assert.fail("unexpected rebuild"));
  assert.equal(result.valid, true);
  assert.equal(result.rebuilt, false);
});

test("a legacy executable without provenance is rebuilt", async t => {
  const f = await fixture(t);
  await mkdir(f.worker, { recursive: true });
  await writeFile(path.join(f.worker, "index.mjs"), "old worker");
  let builds = 0;
  const result = await ensureCurrentWorker(f.root, async reason => {
    assert.match(reason, /manifest/);
    builds++;
    await f.build();
  });
  assert.equal(builds, 1);
  assert.equal(result.rebuilt, true);
});

test("changed TypeScript sources invalidate the cache", async t => {
  const f = await fixture(t);
  await f.build();
  await writeFile(f.source, "export const value = 2;");
  assert.equal((await inspectWorkerBuild(f.root)).valid, false);
  assert.equal((await ensureCurrentWorker(f.root, f.build)).rebuilt, true);
});

for (const name of ["pnpm-lock.yaml", "lib/db/src/index.ts", "artifacts/api-server/build.mjs"]) {
  test(`changes to ${name} invalidate the cache`, async t => {
    const f = await fixture(t);
    await f.build();
    await writeFile(path.join(f.root, name), "changed build input");
    assert.equal((await inspectWorkerBuild(f.root)).valid, false);
  });
}

test("new build helper changes invalidate the cache", async t => {
  const f = await fixture(t);
  await f.build();
  await writeFile(path.join(f.root, "scripts/worker-build-runtime.mjs"), "changed build helper");
  assert.equal((await inspectWorkerBuild(f.root)).valid, false);
});

test("a new revision marker cannot hide an old executable", async t => {
  const f = await fixture(t);
  await f.build();
  await writeFile(path.join(f.root, "deploy-revision.txt"), "new revision");
  assert.equal((await inspectWorkerBuild(f.root)).valid, true);
  await writeFile(path.join(f.worker, "index.mjs"), "old executable");
  assert.equal((await inspectWorkerBuild(f.root)).valid, false);
});

test("fingerprints do not depend on the temporary build location", async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  assert.equal(await getBuildFingerprint(a.root), await getBuildFingerprint(b.root));
});

test("a different runtime mode invalidates the previous compilation", async t => {
  const f = await fixture(t);
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    await f.build();
    process.env.NODE_ENV = "development";
    assert.equal((await inspectWorkerBuild(f.root)).valid, false);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

for (const manifest of ["not json", "null", "{}", '{"version":100}']) {
  test(`malformed manifest ${manifest} is rejected`, async t => {
    const f = await fixture(t);
    await f.build();
    await writeFile(path.join(f.worker, "build-manifest.json"), manifest);
    assert.equal((await inspectWorkerBuild(f.root)).valid, false);
  });
}

for (const name of ["index.mjs", "thread-stream-worker.mjs", "node_modules"]) {
  test(`missing ${name} invalidates the compiled worker`, async t => {
    const f = await fixture(t);
    await f.build();
    await rm(path.join(f.worker, name), { recursive: true });
    assert.equal((await inspectWorkerBuild(f.root)).valid, false);
  });
}

test("build failures preserve the previous executable", async t => {
  const f = await fixture(t);
  await f.build();
  const before = await readFile(path.join(f.worker, "index.mjs"));
  await writeFile(f.source, "new source");
  await assert.rejects(ensureCurrentWorker(f.root, async () => {
    throw new Error("compiler unavailable");
  }), /compiler unavailable/);
  assert.deepEqual(await readFile(path.join(f.worker, "index.mjs")), before);
});

test("a successful command that produces no valid bundle is not accepted", async t => {
  const f = await fixture(t);
  await assert.rejects(ensureCurrentWorker(f.root, async () => {}), /did not produce a valid compilation/);
});

test("sources changing during compilation cannot produce a success manifest", async t => {
  const f = await fixture(t);
  const before = await getBuildFingerprint(f.root);
  await mkdir(path.join(f.worker, "node_modules"), { recursive: true });
  await writeFile(path.join(f.worker, "index.mjs"), "compiled old input");
  await writeFile(f.source, "changed while compiling");
  await assert.rejects(writeBuildManifest(f.root, f.worker, before), /sources changed/);
});

async function promotionFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "worker-promotion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = path.join(root, "stage");
  await mkdir(backup);
  const artifacts = [];
  for (const name of ["dist", "compiled-worker"]) {
    const target = path.join(root, name);
    const staged = path.join(backup, name);
    await mkdir(target);
    await mkdir(staged);
    await writeFile(path.join(target, "index.mjs"), "old");
    await writeFile(path.join(staged, "index.mjs"), "new");
    artifacts.push({ staged, target });
  }
  return { artifacts, backup };
}

test("promotion activates both completed artifacts and retains backup until cleanup", async t => {
  const f = await promotionFixture(t);
  await promoteBuildArtifacts(f.artifacts, f.backup);
  for (const artifact of f.artifacts) {
    assert.equal(await readFile(path.join(artifact.target, "index.mjs"), "utf8"), "new");
  }
  assert.equal(await readFile(path.join(f.backup, "previous-1/index.mjs"), "utf8"), "old");
});

test("failure halfway through promotion restores both original artifacts", async t => {
  const f = await promotionFixture(t);
  await assert.rejects(promoteBuildArtifacts(f.artifacts, f.backup, {
    rm,
    rename: async (from, to) => {
      if (from === f.artifacts[1].staged) throw new Error("promotion failed");
      await rename(from, to);
    },
  }), /promotion failed/);
  for (const artifact of f.artifacts) {
    assert.equal(await readFile(path.join(artifact.target, "index.mjs"), "utf8"), "old");
  }
});

test("recovery failure explicitly retains the staging backups", async t => {
  const f = await promotionFixture(t);
  await assert.rejects(promoteBuildArtifacts(f.artifacts, f.backup, {
    rm,
    rename: async (from, to) => {
      if (from === f.artifacts[1].staged || from === path.join(f.backup, "previous-1")) {
        throw new Error("filesystem failure");
      }
      await rename(from, to);
    },
  }), error => error.preserveBuildStage === true);
  assert.equal(await readFile(path.join(f.backup, "previous-1/index.mjs"), "utf8"), "old");
});

test("pino workers are rebased to their final executing directory", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pino-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "index.mjs");
  await writeFile(filename, `const outputDir = ${JSON.stringify(root)};`);
  await rebasePinoWorkers(root);
  const output = await readFile(filename, "utf8");
  assert.equal(output.includes(JSON.stringify(root)), false);
  assert.match(output, /__bannerUrl\.fileURLToPath\(import\.meta\.url\)/);
});

test("production builds do not require the development pretty transport", () => {
  assert.deepEqual(getBuildTransports("production"), []);
  assert.deepEqual(getBuildTransports("development"), ["pino-pretty"]);
});

test("source maps keep pointing to the original source after promotion", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-sourcemap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, ".build-stage-test/dist");
  const destination = path.join(root, "dist");
  await mkdir(stage, { recursive: true });
  const source = path.join(root, "src/index.ts");
  await writeFile(path.join(stage, "index.mjs.map"), JSON.stringify({
    sources: [path.relative(stage, source)], sourcesContent: ["source"], version: 3,
  }));
  await rebasePinoWorkers(stage, destination);
  const map = JSON.parse(await readFile(path.join(stage, "index.mjs.map"), "utf8"));
  assert.equal(path.resolve(destination, map.sources[0]), source);
  assert.deepEqual(map.sourcesContent, ["source"]);
});

test("thread-stream resolves through pino when a pnpm direct link is absent", () => {
  const actual = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
  const direct = Object.assign(name => actual(name), actual);
  direct.resolve = (name, options) => {
    if (name === "thread-stream") {
      const error = new Error("not directly linked");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return actual.resolve(name, options);
  };
  const resolver = createBuildRequire(direct, createRequire);
  assert.match(resolver.resolve("thread-stream"), /thread-stream/);
  assert.equal(resolver.resolve("pino/package.json"), actual.resolve("pino/package.json"));
  assert.throws(() => resolver.resolve("a-package-that-does-not-exist"), /Cannot find module/);
});