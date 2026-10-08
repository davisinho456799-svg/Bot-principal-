import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { getBuildFingerprint, inspectWorkerBuild, promoteBuildArtifacts, writeBuildManifest } from "../../scripts/worker-build-provenance.mjs";
import { createBuildRequire, getBuildTransports, rebasePinoWorkers } from "../../scripts/worker-build-runtime.mjs";
import { createBuildHistory, safeBuildEvent } from "../../scripts/worker-build-history.mjs";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createBuildRequire(createRequire(import.meta.url), createRequire);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(artifactDir, "../..");
const execFileAsync = promisify(execFile);

async function buildAll() {
  const history = await createBuildHistory(workspaceRoot);
  const inputHash = await history.phase("fingerprint.inputs", () => getBuildFingerprint(workspaceRoot));
  const buildStageDir = await mkdtemp(path.join(artifactDir, ".build-stage-"));
  const distDir = path.join(buildStageDir, "dist");
  const compiledWorkerDir = path.join(buildStageDir, "compiled-worker");
  let preserveStage = false;
  try {

  await history.phase("compile.bundle", () => esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: getBuildTransports(process.env.NODE_ENV) })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  }));
  await history.phase("prepare.worker-paths", () => rebasePinoWorkers(distDir, path.join(artifactDir, "dist")));
  // Syntax validation does not execute the worker or connect to Discord/database.
  await history.phase("validate.syntax", () => execFileAsync(process.execPath, ["--check", path.join(distDir, "index.mjs")]));

  // got-scraping/header-generator lê estes arquivos em runtime.
  // Sem copiá-los, o worker pode falhar com ENOENT para headers-order.json.
  const gotScrapingDir = path.dirname(globalThis.require.resolve("got-scraping"));
  const headerGeneratorEntry = globalThis.require.resolve("header-generator", {
    paths: [gotScrapingDir],
  });
  await history.phase("copy.runtime-assets", () => cp(
    path.join(path.dirname(headerGeneratorEntry), "data_files"),
    path.join(distDir, "data_files"),
    { recursive: true },
  ));

  // Discloud may omit directories named "dist" from the runtime layer after
  // building. Keep a runtime copy outside that ignored directory.
  await history.phase("prepare.worker-copy", () => cp(distDir, compiledWorkerDir, { recursive: true }));

  // The worker uses Playwright and Sharp through lazy imports. Discloud can
  // drop the workspace node_modules between its build and runtime layers, so
  // deploy the production dependency tree next to the compiled entrypoint.
  // Keep Playwright's browser download disabled: discloud.config provides the
  // system Chromium binary separately.
  const runtimeStageDir = path.join(
    tmpdir(),
    `workspace-api-server-runtime-${process.pid}`,
  );
  try {
    await rm(runtimeStageDir, { recursive: true, force: true });
    await history.phase("deploy.runtime-dependencies", () => execFileAsync(
      "corepack",
      [
        "pnpm",
        "deploy",
        "--filter",
        "@workspace/api-server",
        "--prod",
        "--legacy",
        runtimeStageDir,
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    ));
    await history.phase("copy.runtime-dependencies", () => execFileAsync(
      "cp",
      [
        "-a",
        path.join(runtimeStageDir, "node_modules"),
        path.join(compiledWorkerDir, "node_modules"),
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    ));
  } finally {
    await rm(runtimeStageDir, { recursive: true, force: true });
  }
  await history.phase("validate.provenance", async () => {
    await writeBuildManifest(workspaceRoot, compiledWorkerDir, inputHash);
    const candidate = await inspectWorkerBuild(workspaceRoot, compiledWorkerDir);
    if (!candidate.valid) throw new Error(`Invalid staged worker: ${candidate.reason}`);
  });
  await history.phase("activate.outputs", () => promoteBuildArtifacts([
    { staged: distDir, target: path.join(artifactDir, "dist") },
    { staged: compiledWorkerDir, target: path.join(artifactDir, "compiled-worker") },
  ], buildStageDir, {}, event => history.record({ ...event, phase: "activate.outputs" })));
  await history.record({ phase: "build", status: "completed" });
  } catch (error) {
    preserveStage = error.preserveBuildStage === true;
    throw error;
  } finally {
    if (!preserveStage) await rm(buildStageDir, { recursive: true, force: true });
  }
}

buildAll().catch((err) => {
  console.error(JSON.stringify(safeBuildEvent({
    event: "worker_build_failed", errorName: err.name, code: err.code,
    exitCode: Number.isFinite(err.code) ? err.code : err.status,
  })));
  process.exit(1);
});
