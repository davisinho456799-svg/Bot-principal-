import { AutocompleteInteraction } from "discord.js";
import { searchManhwa } from "./anilist.js";
import { searchComick } from "./comick.js";

interface Suggestion {
  name: string;
  value: string;
}

const cache = new Map<string, { results: Suggestion[]; expires: number }>();
const CACHE_TTL_MS = 30_000;

export async function respondAutocomplete(
  interaction: AutocompleteInteraction,
  focusedValue: string
): Promise<void> {
  const query = focusedValue.trim();

  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  const cached = cache.get(query);
  if (cached && cached.expires > Date.now()) {
    await interaction.respond(cached.results.slice(0, 25));
    return;
  }

  try {
    const [anilistRaw, comickRaw] = await Promise.allSettled([
      searchManhwa(query),
      searchComick(query),
    ]);

    const seen = new Set<string>();
    const suggestions: Suggestion[] = [];

    if (anilistRaw.status === "fulfilled") {
      for (const m of anilistRaw.value) {
        const title =
          m.title.english ?? m.title.romaji ?? m.title.native ?? "";
        if (title && !seen.has(title.toLowerCase())) {
          seen.add(title.toLowerCase());
          suggestions.push({ name: title.slice(0, 100), value: title.slice(0, 100) });
        }
      }
    }

    if (comickRaw.status === "fulfilled") {
      for (const m of comickRaw.value) {
        if (m.title && !seen.has(m.title.toLowerCase())) {
          seen.add(m.title.toLowerCase());
          suggestions.push({ name: m.title.slice(0, 100), value: m.title.slice(0, 100) });
        }
      }
    }

    cache.set(query, { results: suggestions, expires: Date.now() + CACHE_TTL_MS });
    await interaction.respond(suggestions.slice(0, 25));
  } catch {
    await interaction.respond([]);
  }
}
