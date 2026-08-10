import { ExternalSourceError } from "./http";
import { searchComick } from "./providers/comick";
import type { MangaAggregate } from "./types";

export async function searchMangaAggregate(query: string): Promise<MangaAggregate> {
  try {
    const results = await searchComick(query);
    return {
      query,
      primarySource: "comick",
      results,
      sources: [
        {
          source: "comick",
          status: results.length > 0 ? "ok" : "empty",
          count: results.length,
        },
      ],
    };
  } catch (error) {
    const message =
      error instanceof ExternalSourceError ? error.message : "Comick request failed";
    return {
      query,
      primarySource: "comick",
      results: [],
      sources: [{ source: "comick", status: "error", count: 0, error: message }],
    };
  }
}