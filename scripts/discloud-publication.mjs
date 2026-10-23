import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "davisinho456799-svg/Bot-principal-";
const BRANCH = "feature/light-bot-mode";
const run = promisify(execFile);
const digest = content => createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
// Local maintenance utilities are not part of the worker's deployed source.
const workspaceTools = new Set([
  "scripts/discloud-compare-postgres.cjs", "scripts/discloud-cutover.mjs",
  "scripts/discloud-exec.mjs", "scripts/discloud-migrate-postgres.cjs",
  "scripts/discloud-reconcile-cutover.cjs",
]);
export function productionPath(name) {
  if (workspaceTools.has(name)) return false;
  if (name.split("/").some(p => ["node_modules", "dist", "compiled-worker", ".git", ".cache", ".build-history"].includes(p) || p.startsWith(".build-stage-") || p.startsWith(".promotion-") || p.startsWith(".env"))) return false;
  if (/\.(tsbuildinfo|jsonl|log|zip|pem|key)$/.test(name) || name.includes("..") || name.startsWith("/")) return false;
  return /^(main\.js|discloud\.config|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.gitignore|tsconfig[^/]*\.json)$/.test(name) ||
    name === ".github/workflows/discloud-deploy.yml" || /^(artifacts\/api-server|lib|scripts)\//.test(name);
}

export function validatePublication({ base, remoteRevision, localHashes, paths, approved = false }) {
  if (!base || base.version !== 1 || !/^[a-f0-9]{40}$/.test(base.revision ?? "") || !base.files) throw new Error("Missing validated production baseline; run init from an aligned workspace");
  if (remoteRevision !== base.revision) throw new Error("Production branch changed; synchronize before publishing");
  if (!paths.length || new Set(paths).size !== paths.length || paths.some(p => !productionPath(p))) throw new Error("Publication paths must be unique application source, never diagnostics or secrets");
  const changed = [...new Set([...Object.keys(base.files), ...Object.keys(localHashes)])].filter(p => base.files[p] !== localHashes[p]);
  const unlisted = changed.filter(p => !paths.includes(p));
  if (unlisted.length) throw new Error("Unlisted production differences: " + unlisted.join(", "));
  if (paths.some(p => !changed.includes(p))) throw new Error("Requested path has no change");
  if (!approved) throw new Error("Explicit user approval required; pass --approved only after obtaining it");
  return changed;
}

async function snapshot(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = path.posix.join(directory, entry.name);
      if (!productionPath(name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Source symlinks cannot be published: " + name);
      if (entry.isDirectory()) await walk(name);
      else files[name] = digest(await readFile(path.join(root, name), "utf8"));
    }
  }
  for (const directory of ["artifacts/api-server", "lib", "scripts"]) await walk(directory);
  for (const name of ["main.js", "discloud.config", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".gitignore", "tsconfig.json", "tsconfig.base.json", ".github/workflows/discloud-deploy.yml"]) {
    try { files[name] = digest(await readFile(path.join(root, name), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return files;
}

export async function publicationCLI(args, root = process.cwd()) {
  const token = process.env.GITHUB_WORKFLOW_TOKEN;
  if (!token) throw new Error("Repository-scoped GitHub workflow credential is not configured");
  const api = async (endpoint, method = "GET", body) => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint} HTTP ${response.status}`);
    return response.json();
  };
  const baselinePath = path.join(root, ".local/discloud-publication/base.json");
  const ref = await api(`/git/ref/heads/${BRANCH}`);
  const revision = ref.object.sha;
  const localHashes = await snapshot(root);
  if (args[0] === "init") {
    const commit = await api(`/git/commits/${revision}`);
    const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error("Remote source tree is truncated");
    const originals = {};
    for (const entry of tree.tree.filter(e => e.type === "blob" && productionPath(e.path))) {
      const blob = await api(`/git/blobs/${entry.sha}`);
      originals[entry.path] = digest(Buffer.from(blob.content, "base64").toString("utf8"));
    }
    const mismatches = [...new Set([...Object.keys(originals), ...Object.keys(localHashes)])].filter(p => originals[p] !== localHashes[p]);
    if (mismatches.length) throw new Error("Workspace is not aligned with production: " + mismatches.join(", "));
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify({ version: 1, revision, files: originals }, null, 2));
    console.log("Validated production baseline saved");
    return;
  }
  if (!["check", "publish"].includes(args[0])) throw new Error("Use init, check --approved paths..., or publish --approved paths...");
  const paths = args.slice(1).filter(p => p !== "--approved");
  const base = JSON.parse(await readFile(baselinePath, "utf8"));
  validatePublication({ base, remoteRevision: revision, localHashes, paths, approved: args.includes("--approved") });
  console.log(`Publication preflight passed for ${paths.length} source files`);
  if (args[0] === "check") return;
  const tests = (await readdir(path.join(root, "scripts"))).filter(n => n.endsWith(".test.mjs")).map(n => "scripts/" + n);
  const options = { cwd: root, timeout: 240_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, DISCORD_BOT_ENABLED: "false", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", PORT: process.env.PORT || "8080", BASE_PATH: process.env.BASE_PATH || "/" } };
  for (const [command, argv] of [
    [process.execPath, ["--test", ...tests]],
    ["corepack", ["pnpm", "run", "typecheck"]],
    ["corepack", ["pnpm", "--filter", "@workspace/api-server", "run", "test"]],
    ["corepack", ["pnpm", "--filter", "@workspace/api-server", "run", "build"]],
  ]) {
    console.log(`Running publication verification: ${argv.join(" ")}`);
    try {
      const { stdout } = await run(command, argv, {
        ...options,
        env: { ...options.env, NODE_ENV: argv.includes("test") || argv.includes("--test") ? "test" : "production" },
      });
      for (const line of stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
        const count = line.match(/^ℹ (tests|pass|fail) (\d+)$/) || line.match(/^\s*(Tests|Test Files)\s+(\d+) passed/);
        if (count) console.log(JSON.stringify({ verification: count[1], count: Number(count[2]) }));
      }
    }
    catch { throw new Error(`Publication verification failed: ${argv.join(" ")}; branch was not updated`); }
  }
  const after = await snapshot(root);
  if (JSON.stringify(after) !== JSON.stringify(localHashes)) throw new Error("Source changed during verification; refusing publication");
  if ((await api(`/git/ref/heads/${BRANCH}`)).object.sha !== revision) throw new Error("Remote branch changed during verification");
  const parent = await api(`/git/commits/${revision}`);
  const entries = [];
  for (const name of paths) {
    const content = localHashes[name] ? await readFile(path.join(root, name)) : null;
    const blob = content ? await api("/git/blobs", "POST", { content: content.toString("base64"), encoding: "base64" }) : null;
    entries.push({ path: name, mode: "100644", type: "blob", sha: blob?.sha ?? null });
  }
  const tree = await api("/git/trees", "POST", { base_tree: parent.tree.sha, tree: entries });
  const commit = await api("/git/commits", "POST", { message: "Harden worker startup, safe publication and durable deployment diagnostics", tree: tree.sha, parents: [revision] });
  if ((await api(`/git/ref/heads/${BRANCH}`)).object.sha !== revision) throw new Error("Remote changed before branch update; commit not published");
  await api(`/git/refs/heads/${BRANCH}`, "PATCH", { sha: commit.sha, force: false });
  if ((await api(`/git/ref/heads/${BRANCH}`)).object.sha !== commit.sha) throw new Error("Published branch could not be confirmed");
  await writeFile(baselinePath, JSON.stringify({ version: 1, revision: commit.sha, files: after }, null, 2));
  console.log(JSON.stringify({ published: true, revision: commit.sha }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  publicationCLI(process.argv.slice(2)).catch(error => {
    console.error(error.message); // Static guard/API messages only; never dump child command output.
    process.exitCode = 1;
  });
}