import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST = "build-manifest.json";
const VERSION = 1;
const ignoredDirectories = new Set(["node_modules", "dist", "compiled-worker", ".git", "__tests__"]);

async function filesUnder(directory, { outputs = false } = {}) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(filename, { outputs }));
    else if (entry.isFile() && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      if (outputs && (entry.name === MANIFEST || entry.name.endsWith(".map"))) continue;
      files.push(filename);
    }
  }
  return files.sort();
}

async function optionalFiles(directory) {
  try { return await filesUnder(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function digestFiles(root, files, header = "") {
  const hash = createHash("sha256").update(header);
  for (const filename of [...new Set(files)].sort()) {
    const content = await readFile(filename);
    hash.update(path.relative(root, filename).split(path.sep).join("/"));
    hash.update("\0").update(String(content.length)).update("\0").update(content);
  }
  return hash.digest("hex");
}

export async function getBuildFingerprint(root) {
  const artifact = path.join(root, "artifacts/api-server");
  const files = [
    ...await filesUnder(path.join(artifact, "src")),
    path.join(artifact, "build.mjs"),
    path.join(artifact, "package.json"),
    ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map(name => path.join(root, name)),
    ...await optionalFiles(path.join(root, "scripts/worker-build")),
  ];
  // These helpers affect build correctness, but unrelated migration scripts do not.
  for (const name of ["worker-build-provenance.mjs", "worker-build-runtime.mjs"]) {
    const filename = path.join(root, "scripts", name);
    try { await access(filename); files.push(filename); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const entry of await readdir(path.join(root, "lib"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, "lib", entry.name);
    files.push(...await optionalFiles(path.join(directory, "src")));
    try { await access(path.join(directory, "package.json")); files.push(path.join(directory, "package.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const environment = {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split(".")[0],
    mode: process.env.NODE_ENV ?? "development",
  };
  return digestFiles(root, files, JSON.stringify(environment));
}

async function outputFingerprint(directory) {
  return digestFiles(directory, await filesUnder(directory, { outputs: true }));
}

export async function writeBuildManifest(root, directory, inputHash) {
  if (await getBuildFingerprint(root) !== inputHash) {
    throw new Error("Worker sources changed during compilation; refusing to activate a mixed build");
  }
  await access(path.join(directory, "index.mjs"));
  const dependencies = await stat(path.join(directory, "node_modules"));
  if (!dependencies.isDirectory()) throw new Error("Worker runtime dependencies are missing");
  const manifest = {
    version: VERSION,
    inputHash,
    outputHash: await outputFingerprint(directory),
    builtAt: new Date().toISOString(),
  };
  await writeFile(path.join(directory, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function inspectWorkerBuild(root, directory = path.join(root, "artifacts/api-server/compiled-worker")) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, MANIFEST), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { valid: false, reason: "missing build manifest" };
    if (error instanceof SyntaxError) return { valid: false, reason: "invalid build manifest" };
    throw error;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.version !== VERSION || !/^[a-f0-9]{64}$/.test(manifest.inputHash ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.outputHash ?? "")) {
    return { valid: false, reason: "invalid build manifest" };
  }
  if (manifest.inputHash !== await getBuildFingerprint(root)) {
    return { valid: false, reason: "compiled worker does not match current sources or runtime" };
  }
  try {
    await access(path.join(directory, "index.mjs"));
    if (!(await stat(path.join(directory, "node_modules"))).isDirectory()) {
      return { valid: false, reason: "missing runtime dependencies" };
    }
    if (manifest.outputHash !== await outputFingerprint(directory)) {
      return { valid: false, reason: "compiled worker files changed or are incomplete" };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { valid: false, reason: "incomplete compiled worker" };
    throw error;
  }
  return { valid: true, inputHash: manifest.inputHash };
}

export async function ensureCurrentWorker(root, build) {
  const previous = await inspectWorkerBuild(root);
  if (previous.valid) return { rebuilt: false, ...previous };
  await build(previous.reason);
  const current = await inspectWorkerBuild(root);
  if (!current.valid) throw new Error(`Worker rebuild did not produce a valid compilation: ${current.reason}`);
  return { rebuilt: true, ...current };
}

/** Swap only fully built artifacts; restore both old directories if promotion fails. */
export async function promoteBuildArtifacts(artifacts, backupDirectory, filesystem = { rename, rm }) {
  const changes = [];
  try {
    for (const [index, artifact] of artifacts.entries()) {
      const change = { ...artifact, backup: path.join(backupDirectory, `previous-${index}`), backedUp: false, promoted: false };
      changes.push(change);
      try {
        await filesystem.rename(change.target, change.backup);
        change.backedUp = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await filesystem.rename(change.staged, change.target);
      change.promoted = true;
    }
  } catch (error) {
    const failures = [];
    for (const change of changes.reverse()) {
      try {
        if (change.promoted) await filesystem.rm(change.target, { recursive: true, force: true });
        if (change.backedUp) await filesystem.rename(change.backup, change.target);
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) {
      const failure = new AggregateError([error, ...failures], "Worker build activation failed; preserve staging backups for recovery");
      failure.preserveBuildStage = true;
      throw failure;
    }
    throw error;
  }
}