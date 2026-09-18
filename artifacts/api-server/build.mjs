import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(artifactDir, "../..");
const execFileAsync = promisify(execFile);

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  const compiledWorkerDir = path.resolve(artifactDir, "compiled-worker");
  await rm(distDir, { recursive: true, force: true });
  await rm(compiledWorkerDir, { recursive: true, force: true });

  await esbuild({
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
      esbuildPluginPino({ transports: ["pino-pretty"] })
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
  });

  // got-scraping/header-generator lê estes arquivos em runtime.
  // Sem copiá-los, o Railway falha com ENOENT para headers-order.json.
  const gotScrapingDir = path.dirname(globalThis.require.resolve("got-scraping"));
  const headerGeneratorEntry = globalThis.require.resolve("header-generator", {
    paths: [gotScrapingDir],
  });
  await cp(
    path.join(path.dirname(headerGeneratorEntry), "data_files"),
    path.join(distDir, "data_files"),
    { recursive: true },
  );

  // Discloud may omit directories named "dist" from the runtime layer after
  // building. Keep a runtime copy outside that ignored directory.
  await cp(distDir, compiledWorkerDir, { recursive: true });

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
    await execFileAsync(
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
    );
    await execFileAsync(
      "cp",
      [
        "-a",
        path.join(runtimeStageDir, "node_modules"),
        path.join(compiledWorkerDir, "node_modules"),
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  } finally {
    await rm(runtimeStageDir, { recursive: true, force: true });
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
