import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

type MonitorDependency = "sharp" | "playwright";

/** Discloud overlays can retain pnpm packages while losing their public links. */
export function createMonitorDependencyLoader({
  roots = [process.cwd(), path.resolve(process.cwd(), "../..")],
  loadModule = (specifier: string): Promise<unknown> => import(specifier),
} = {}) {
  const ready = new Map<MonitorDependency, Promise<unknown>>();
  return function load(name: MonitorDependency): Promise<unknown> {
    if (ready.has(name)) return ready.get(name)!;
    const pending = (async () => {
      try { return await loadModule(name); }
      catch (originalError) {
        for (const root of [...new Set(roots)]) {
          try {
            const manifest = JSON.parse(await readFile(path.join(root, "artifacts/api-server/package.json"), "utf8"));
            const version = String(manifest.dependencies?.[name] ?? "").match(/^[~^]?(\d+\.\d+\.\d+)$/)?.[1];
            if (!version) continue;
            // Only the declared version, never an arbitrary older installation.
            for (const store of [
              path.join(root, "artifacts/api-server/compiled-worker/node_modules/.pnpm"),
              path.join(root, "node_modules/.pnpm"),
            ]) {
              let entries: string[];
              try { entries = await readdir(store); } catch { continue; }
              for (const entry of entries.filter(value => value === `${name}@${version}` || value.startsWith(`${name}@${version}_`)).sort()) {
                try {
                  const location = path.join(store, entry, "node_modules", name);
                  const resolved = createRequire(path.join(root, "package.json")).resolve(location);
                  return await loadModule(pathToFileURL(resolved).href);
                } catch { /* Try another intact copy of the same version. */ }
              }
            }
          } catch { /* This root is not a usable production workspace. */ }
        }
        throw originalError;
      }
    })();
    ready.set(name, pending);
    pending.catch(() => { if (ready.get(name) === pending) ready.delete(name); });
    return pending;
  };
}

export const loadMonitorDependency = createMonitorDependencyLoader();