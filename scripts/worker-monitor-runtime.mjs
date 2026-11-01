import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_TIMEOUT_MS = 60_000;
export const BROWSER_TIMEOUT_MS = 90_000;

export function createMonitorPreparation({
  root, env = process.env, command = promisify(execFile), canAccess = access,
  loadModule = url => import(url), history,
}) {
  async function packageRoot(name) {
    for (const directory of ["node_modules", "artifacts/api-server/node_modules", "artifacts/api-server/compiled-worker/node_modules"]) {
      const location = path.join(root, directory, name);
      try { await canAccess(path.join(location, "package.json")); return location; }
      catch { /* Try the next installation location. */ }
    }
    return null;
  }
  async function degraded(phase, error) {
    await history.record({ phase, status: "degraded", code: error?.code, errorName: error?.name });
    console.warn(`${phase}: optional dependency unavailable; parser/text fallback remains enabled`);
  }
  return async function prepare() {
    const required = ["playwright", "sharp"];
    const missing = [];
    for (const name of required) if (!await packageRoot(name)) missing.push(name);
    if (missing.length) {
      await history.record({ phase: "recover.monitor-dependencies", status: "started" });
      try {
        await command("corepack", ["pnpm", "install", "--prod", "--frozen-lockfile"], {
          cwd: root, env: { ...env, CI: "true", NODE_ENV: "production", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
          timeout: PACKAGE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 20 * 1024 * 1024,
        });
        for (const name of required) if (!await packageRoot(name)) throw Object.assign(new Error("Optional package missing"), { code: "OPTIONAL_PACKAGE_MISSING" });
        await history.record({ phase: "recover.monitor-dependencies", status: "completed" });
      } catch (error) { await degraded("recover.monitor-dependencies", error); }
    }
    const candidates = [env.PLAYWRIGHT_EXECUTABLE_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/chromium"].filter(Boolean);
    for (const candidate of candidates) {
      try { await canAccess(candidate, constants.X_OK); env.PLAYWRIGHT_EXECUTABLE_PATH = candidate; return; }
      catch { /* Continue browser discovery. */ }
    }
    try {
      const { stdout } = await command("sh", ["-c", "command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable"], {
        timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      const discovered = stdout.trim().split(/\s+/)[0];
      if (discovered) { await canAccess(discovered, constants.X_OK); env.PLAYWRIGHT_EXECUTABLE_PATH = discovered; return; }
    } catch { /* Managed Chromium may already exist. */ }
    delete env.PLAYWRIGHT_EXECUTABLE_PATH;
    const playwright = await packageRoot("playwright");
    if (!playwright) { await degraded("prepare.browser", { code: "PLAYWRIGHT_UNAVAILABLE" }); return; }
    try {
      const module = await loadModule(pathToFileURL(path.join(playwright, "index.mjs")).href);
      const executable = module.chromium.executablePath();
      await canAccess(executable, constants.X_OK);
      return; // Reuse an existing managed browser instead of downloading every boot.
    } catch { /* Missing browser or package: attempt one bounded recovery. */ }
    await history.record({ phase: "recover.browser", status: "started" });
    const installEnv = { ...env, CI: "true", NODE_ENV: "production" };
    delete installEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    try {
      await command(process.execPath, [path.join(playwright, "cli.js"), "install", "chromium-headless-shell"], {
        cwd: root, env: installEnv, timeout: BROWSER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 40 * 1024 * 1024,
      });
      await history.record({ phase: "recover.browser", status: "completed" });
    } catch (error) { await degraded("recover.browser", error); }
  };
}