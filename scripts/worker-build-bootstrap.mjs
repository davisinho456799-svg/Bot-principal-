import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const retiredSources = [
  "artifacts/api-server/src/bot/commands/filme.ts",
  "artifacts/api-server/src/bot/tmdb.ts",
];

/** Commit uploads overlay files; remove only these explicitly retired sources. */
export async function removeRetiredWorkerSources(root) {
  for (const filename of retiredSources) {
    // No recursive deletion: a directory at either path must fail explicitly.
    await rm(path.join(root, filename), { force: true });
  }
}

/** Called only for an invalid compilation, never on an unchanged healthy boot. */
export async function rebuildWorker(root, {
  env = process.env,
  run = execute,
  history = { phase: async (_name, action) => action() },
} = {}) {
  const options = {
    cwd: root,
    env: {
      ...env,
      NODE_ENV: env.NODE_ENV ?? "production",
      CI: "true",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    timeout: 10 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
  };
  // Runtime layers can retain the compiled dependency tree but drop build links.
  // Keep the approved lockfile and include the tools needed for rebuilding.
  await history.phase("prepare.build-dependencies", () => run(
    "corepack",
    ["pnpm", "install", "--frozen-lockfile", "--prod=false"],
    options,
  ));
  return run(process.execPath, [path.join(root, "artifacts/api-server/build.mjs")], options);
}