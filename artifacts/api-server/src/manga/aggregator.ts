import { ExternalSourceError } from "./http";
import { searchAniList } from "./providers/anilist";
import { searchComick } from "./providers/comick";
import { searchJikan } from "./providers/jikan";
import { searchMangaDex } from "./providers/mangadex";
import { searchMangaUpdates } from "./providers/mangaupdates";
import type {
  MangaAggregate,
  MangaRecord,
  MangaSource,
  SourceStatus,
} from "./types";

const providers: Array<{
  source: MangaSource;
  search: (query: string) => Promise<MangaRecord[]>;
}> = [
  { source: "comick", search: searchComick },
  { source: "mangaupdates", search: searchMangaUpdates },
  { source: "mangadex", search: searchMangaDex },
  { source: "jikan", search: searchJikan },
  { source: "anilist", search: searchAniList },
];

export async function searchMangaAggregate(query: string): Promise<MangaAggregate> {
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.search(query)),
  );
  const results: MangaRecord[] = [];
  const sources: SourceStatus[] = [];

  settled.forEach((result, index) => {
    const source = providers[index].source;
    if (result.status === "fulfilled") {
      results.push(...result.value);
      sources.push({
        source,
        status: result.value.length > 0 ? "ok" : "empty",
        count: result.value.length,
      });
      return;
    }

    const error = result.reason;
    sources.push({
      source,
      status: "error",
      count: 0,
      error:
        error instanceof ExternalSourceError
          ? error.message
          : "source request failed",
    });
  });

  return { query, primarySource: "comick", results, sources };
}