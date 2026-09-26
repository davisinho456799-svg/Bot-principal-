// Discloud entrypoint for the compiled Discord worker.
// Defaults are intentionally lightweight for a single 4 GB deployment.
import { execFile } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV ??= "production";
process.env.DISCORD_BOT_ENABLED = "true";
process.env.DISCORD_LIGHT_MODE ??= "true";
process.env.LIGHT_MODE_NOTIFICATIONS ??= "true";
process.env.MONITOR_INTERVAL_MINUTES ??= "420";
process.env.EMBED_MONITOR_INTERVAL_HOURS ??= "24";
console.log("Panel Watch Discord worker build: embed-limit-fix-v2");

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "index.mjs");
const workerUrl = pathToFileURL(workerPath).href;
const apiServerNodeModules = path.join(projectRoot, "artifacts", "api-server", "node_modules");
const browserCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/chromium",
].filter((candidate, index, candidates) =>
  candidate && candidates.indexOf(candidate) === index
);

async function findRuntimePackageRoot(packageName) {
  const packageLocations = [
    path.join(projectRoot, "node_modules", packageName, "package.json"),
    path.join(apiServerNodeModules, packageName, "package.json"),
    path.join(projectRoot, "artifacts", "api-server", "compiled-worker", "node_modules", packageName, "package.json"),
  ];
  for (const packagePath of packageLocations) {
    try {
      await access(packagePath);
      return path.dirname(packagePath);
    } catch {
      // Check the next location used by pnpm or the Discloud runtime layer.
    }
  }
  return null;
}

async function hasRuntimePackage(packageName) {
  return Boolean(await findRuntimePackageRoot(packageName));
}

async function ensureBrowserExecutable() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      process.env.PLAYWRIGHT_EXECUTABLE_PATH = candidate;
      console.log(`Chromium encontrado em ${candidate}.`);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "sh",
      [
        "-c",
        "command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const discovered = stdout.trim().split(/\s+/)[0];
    if (discovered) {
      await access(discovered, fsConstants.X_OK);
      process.env.PLAYWRIGHT_EXECUTABLE_PATH = discovered;
      console.log(`Chromium encontrado pelo PATH em ${discovered}.`);
      return discovered;
    }
  } catch {
    // Playwright may still find its managed browser if one is present.
  }

  delete process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  console.warn(
    "Nenhum Chromium do sistema foi encontrado; o Playwright tentará usar o navegador gerenciado, se estiver instalado.",
  );
  return null;
}

async function ensureManagedBrowser() {
  const playwrightRoot = await findRuntimePackageRoot("playwright");
  if (!playwrightRoot) {
    console.warn(
      "Playwright não está instalado; não foi possível baixar o navegador gerenciado.",
    );
    return false;
  }

  const playwrightCli = path.join(playwrightRoot, "cli.js");
  console.warn(
    "Nenhum Chromium do sistema foi encontrado; baixando o Chromium gerenciado pelo Playwright.",
  );
  const installEnv = { ...process.env, CI: "true", NODE_ENV: "production" };
  delete installEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [playwrightCli, "install", "chromium-headless-shell"],
      {
        cwd: projectRoot,
        env: installEnv,
        maxBuffer: 40 * 1024 * 1024,
      },
    );
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    console.log("Chromium gerenciado pelo Playwright instalado.");
    return true;
  } catch (error) {
    const details = error && typeof error === "object"
      ? [
        "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "",
        "stdout" in error && typeof error.stdout === "string" ? error.stdout.trim() : "",
      ].filter(Boolean).join("\n")
      : "";
    console.warn(
      "Não foi possível baixar o Chromium gerenciado; o monitor usará o parser sem captura.",
      details || error,
    );
    return false;
  }
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
          CI: "true",
          NODE_ENV: "production",
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
    const details = error && typeof error === "object"
      ? [
        "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "",
        "stdout" in error && typeof error.stdout === "string" ? error.stdout.trim() : "",
      ].filter(Boolean).join("\n")
      : "";
    console.warn(
      "Não foi possível reinstalar as dependências do monitor; o bot continuará sem imagens de fallback.",
      details || error,
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
  const systemBrowser = await ensureBrowserExecutable();
  if (!systemBrowser) await ensureManagedBrowser();
  await ensureCompiledWorker();
  await import(workerUrl);
} catch (error) {
  console.error("Failed to start the compiled Discord worker:", error);
  process.exitCode = 1;
}