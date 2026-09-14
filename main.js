// Discloud entrypoint for the compiled Discord worker.
// Defaults are intentionally lightweight for a single 4 GB deployment.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV ??= "production";
process.env.DISCORD_BOT_ENABLED = "true";
process.env.DISCORD_LIGHT_MODE ??= "true";
process.env.MONITOR_INTERVAL_MINUTES ??= "60";
process.env.PLAYWRIGHT_EXECUTABLE_PATH ??= "/usr/bin/chromium";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "index.mjs");
const workerUrl = pathToFileURL(workerPath).href;
const apiServerNodeModules = path.join(projectRoot, "artifacts", "api-server", "node_modules");

async function hasRuntimePackage(packageName) {
  const packageLocations = [
    path.join(projectRoot, "node_modules", packageName, "package.json"),
    path.join(apiServerNodeModules, packageName, "package.json"),
    path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "node_modules", packageName, "package.json"),
  ];
  for (const packagePath of packageLocations) {
    try {
      await access(packagePath);
      return true;
    } catch {
      // Check the next location used by pnpm or the Discloud runtime layer.
    }
  }
  return false;
}

async function ensureMonitorDependencies() {
  const requiredPackages = ["playwright", "sharp"];
  const missingPackages = [];
  for (const packageName of requiredPackages) {
    if (!(await hasRuntimePackage(packageName))) missingPackages.push(packageName);
  }
  if (!missingPackages.length) return;

  console.warn(
    `Monitor packages ausentes (${missingPackages.join(", ")}); reinstalando dependências de produção.`,
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      "corepack",
      ["pnpm", "install", "--prod", "--frozen-lockfile"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    const stillMissing = [];
    for (const packageName of missingPackages) {
      if (!(await hasRuntimePackage(packageName))) stillMissing.push(packageName);
    }
    if (stillMissing.length) {
      console.warn(
        `Dependências do monitor ainda indisponíveis (${stillMissing.join(", ")}); o monitor usará o fallback sem imagem.`,
      );
    }
  } catch (error) {
    console.warn(
      "Não foi possível reinstalar as dependências do monitor; o bot continuará sem imagens de fallback.",
      error,
    );
  }
}

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
  await ensureMonitorDependencies();
  await ensureCompiledWorker();
  await import(workerUrl);
} catch (error) {
  console.error("Failed to start the compiled Discord worker:", error);
  process.exitCode = 1;
}