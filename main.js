// Discloud entrypoint; optional monitor recovery must not delay Discord startup.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ensureCurrentWorker } from "./scripts/worker-build-provenance.mjs";
import { createBuildHistory, extractBuildEvents, safeBuildEvent } from "./scripts/worker-build-history.mjs";
import { startWorker } from "./scripts/worker-startup.mjs";
import { createMonitorPreparation } from "./scripts/worker-monitor-runtime.mjs";

process.env.NODE_ENV ??= "production";
process.env.DISCORD_BOT_ENABLED = "true";
process.env.DISCORD_LIGHT_MODE ??= "true";
process.env.LIGHT_MODE_NOTIFICATIONS ??= "true";
process.env.MONITOR_INTERVAL_MINUTES ??= "60";
process.env.EMBED_MONITOR_INTERVAL_HOURS ??= "24";
console.log("Panel Watch Discord worker build: embed-limit-fix-v2");

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "index.mjs");
const workerUrl = pathToFileURL(workerPath).href;

async function ensureCompiledWorker() {
  await ensureCurrentWorker(projectRoot, async (reason) => {
    console.warn(`Rebuilding compiled Discord worker: ${reason}`);
    const buildScript = path.join(projectRoot, "artifacts", "api-server", "build.mjs");
    const { stdout } = await execFileAsync(process.execPath, [buildScript], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      timeout: 10 * 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const event of extractBuildEvents(stdout)) console.log(JSON.stringify(event));
  });
}

const startupHistory = await createBuildHistory(projectRoot, { kind: "startup" });
try {
  await startWorker({
    history: startupHistory,
    validate: ensureCompiledWorker,
    load: () => import(workerUrl),
    prepare: createMonitorPreparation({ root: projectRoot, history: startupHistory }),
  });
} catch (error) {
  for (const event of extractBuildEvents(error.stdout)) console.error(JSON.stringify(event));
  console.error("Failed to start the compiled Discord worker:", JSON.stringify(safeBuildEvent({
    errorName: error.name, code: error.code,
    exitCode: Number.isFinite(error.code) ? error.code : error.status,
  })));
  process.exitCode = 1;
}