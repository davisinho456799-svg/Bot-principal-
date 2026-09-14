// Discloud entrypoint for the compiled Discord worker.
// Defaults are intentionally lightweight for a single 4 GB deployment.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV ??= "production";
process.env.DISCORD_LIGHT_MODE ??= "true";
process.env.MONITOR_INTERVAL_MINUTES ??= "60";
process.env.PLAYWRIGHT_EXECUTABLE_PATH ??= "/usr/bin/chromium";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "index.mjs");
const workerUrl = pathToFileURL(workerPath).href;

async function ensureCompiledWorker() {
  try {
    await access(workerPath);
    return;
  } catch {
    console.warn("Compiled Discord worker not found; rebuilding it before startup.");
  }

  const buildScript = path.join(projectRoot, "artifacts", "api-server", "build.mjs");
  const { stdout, stderr } = await execFileAsync(process.execPath, [buildScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
  await access(workerPath);
}

try {
  await ensureCompiledWorker();
  await import(workerUrl);
} catch (error) {
  console.error("Failed to start the compiled Discord worker:", error);
  process.exitCode = 1;
}