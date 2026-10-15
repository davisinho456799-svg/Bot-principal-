import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMonitorDependencyLoader } from "./monitor-dependencies";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "monitor-deps-"));
  roots.push(root);
  await mkdir(path.join(root, "artifacts/api-server"), { recursive: true });
  await writeFile(path.join(root, "artifacts/api-server/package.json"), JSON.stringify({ dependencies: { sharp: "^0.35.4", playwright: "^1.63.0" } }));
  return root;
}

async function install(root: string, name: string, version: string, value: string) {
  const directory = path.join(root, "node_modules/.pnpm", `${name}@${version}`, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ main: "index.cjs" }));
  await writeFile(path.join(directory, "index.cjs"), `module.exports = ${JSON.stringify(value)};`);
}

describe("monitor dependencies after a Discloud overlay", () => {
  it("reuses the declared intact store version when package links are missing", async () => {
    const root = await fixture();
    await install(root, "sharp", "0.33.0", "wrong-version");
    await install(root, "sharp", "0.35.4", "working-sharp");
    await install(root, "playwright", "1.63.0", "working-playwright");
    const load = createMonitorDependencyLoader({ roots: [root], loadModule: specifier => {
      if (!specifier.startsWith("file:")) return Promise.reject(new Error("missing public link"));
      return import(specifier);
    } });
    expect((await load("sharp") as { default: string }).default).toBe("working-sharp");
    expect((await load("playwright") as { default: string }).default).toBe("working-playwright");
  });

  it("prefers ordinary resolution and caches successful loads", async () => {
    const loadModule = vi.fn(async () => ({ default: "normal" }));
    const load = createMonitorDependencyLoader({ roots: [], loadModule });
    await Promise.all([load("sharp"), load("sharp")]);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("does not substitute an old package and can recover after preparation finishes", async () => {
    const root = await fixture();
    await install(root, "sharp", "0.33.0", "wrong-version");
    const load = createMonitorDependencyLoader({ roots: [root], loadModule: specifier => {
      if (!specifier.startsWith("file:")) return Promise.reject(new Error("not ready"));
      return import(specifier);
    } });
    await expect(load("sharp")).rejects.toThrow("not ready");
    await install(root, "sharp", "0.35.4", "recovered");
    expect((await load("sharp") as { default: string }).default).toBe("recovered");
  });
});