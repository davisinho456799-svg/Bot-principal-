import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandDefinitions, commandRegistry } from "../command-registry.js";

describe("active bot commands", () => {
  it("enables title autocomplete for anime and manga without changing free-text options", () => {
    for (const name of ["anime", "manga"]) {
      const definition = commandDefinitions.find(command => command.name === name)!;
      const title = definition.options?.find(option => option.name === "titulo");
      expect(title).toMatchObject({ autocomplete: true, required: name === "manga" });
      expect(typeof commandRegistry.get(name)?.autocomplete).toBe("function");
    }
    const anime = commandDefinitions.find(command => command.name === "anime")!;
    expect(anime.options?.find(option => option.name === "descricao")).not.toHaveProperty("autocomplete", true);
  });

  it("keeps a unique executable handler for every published command", () => {
    const names = commandDefinitions.map(command => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(commandRegistry.size).toBe(names.length);
    for (const name of names) {
      expect(typeof commandRegistry.get(name)?.execute).toBe("function");
    }
  });

  it("does not offer the retired filme command", () => {
    expect(commandRegistry.has("filme")).toBe(false);
    expect(commandDefinitions.some(command => command.name === "filme")).toBe(false);
    expect(existsSync(new URL("../commands/filme.ts", import.meta.url))).toBe(false);
  });

  it("does not retain TMDB integration in image identification", () => {
    const engine = readFileSync(new URL("../identificar-engine.ts", import.meta.url), "utf8");
    expect(engine).not.toMatch(/tmdb/i);
    expect(existsSync(new URL("../tmdb.ts", import.meta.url))).toBe(false);
  });
});