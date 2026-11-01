// Discloud entrypoint; optional monitor recovery must not delay Discord startup.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureCurrentWorker } from "./scripts/worker-build-provenance.mjs";
import { rebuildWorker, removeRetiredWorkerSources } from "./scripts/worker-build-bootstrap.mjs";
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

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "index.mjs");
const workerUrl = pathToFileURL(workerPath).href;

async function ensureCompiledWorker() {
  await startupHistory.phase("cleanup.retired-sources", () => removeRetiredWorkerSources(projectRoot));
  await ensureCurrentWorker(projectRoot, async (reason) => {
    console.warn(`Rebuilding compiled Discord worker: ${reason}`);
    const { stdout } = await rebuildWorker(projectRoot, { history: startupHistory });
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