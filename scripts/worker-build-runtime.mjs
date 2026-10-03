import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";

/** pnpm production installs do not expose pino's transitive peer at the artifact root. */
export function createBuildRequire(projectRequire, createRequire) {
  const pinoRequire = createRequire(projectRequire.resolve("pino/package.json"));
  const buildRequire = Object.assign(name => projectRequire(name), projectRequire);
  buildRequire.resolve = (name, options) => {
    try { return projectRequire.resolve(name, options); }
    catch (error) {
      if (name !== "thread-stream" || error.code !== "MODULE_NOT_FOUND") throw error;
      return pinoRequire.resolve(name, options);
    }
  };
  return buildRequire;
}

export function getBuildTransports(mode) {
  return mode === "production" ? [] : ["pino-pretty"];
}

/** Pino must resolve workers beside the executing bundle, not in the build staging directory. */
export async function rebasePinoWorkers(directory, finalDirectory = directory) {
  const literal = JSON.stringify(directory);
  const runtimeDirectory = "__bannerPath.dirname(__bannerUrl.fileURLToPath(import.meta.url))";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.name.endsWith(".mjs.map")) {
      const map = JSON.parse(await readFile(filename, "utf8"));
      map.sources = map.sources.map(source => {
        if (source.startsWith("<") || /^[a-z]+:\/\//i.test(source)) return source;
        return path.relative(finalDirectory, path.resolve(directory, source)).split(path.sep).join("/");
      });
      await writeFile(filename, JSON.stringify(map));
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const content = await readFile(filename, "utf8");
    if (content.includes(literal)) {
      await writeFile(filename, content.replaceAll(literal, runtimeDirectory));
    }
  }
}