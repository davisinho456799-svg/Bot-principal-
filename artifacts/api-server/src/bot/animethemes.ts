/**
 * AnimeThemes API — aberturas e encerramentos de anime.
 * Documentação: https://api.animethemes.moe/
 */

const ANIMETHEMES_API = "https://api.animethemes.moe";

interface ATVideo {
  link: string;
  resolution: number | null;
  nc: boolean;
}

interface ATEntry {
  episodes: string | null;
  videos: ATVideo[];
}

interface ATArtist {
  name: string;
}

interface ATSong {
  title: string;
  artists: ATArtist[];
}

interface ATTheme {
  type: "OP" | "ED";
  sequence: number | null;
  slug: string;
  song: ATSong | null;
  animethemeentries: ATEntry[];
}

interface ATAnime {
  name: string;
  slug: string;
  animethemes: ATTheme[];
}

export interface AnimeTheme {
  type: "OP" | "ED";
  sequence: number | null;
  slug: string;
  songTitle: string;
  artists: string[];
  episodes: string | null;
  videoUrl: string | null;
  videoNC: string | null; // versão sem créditos
}

export interface AnimeThemesResult {
  animeName: string;
  animeSlug: string;
  themes: AnimeTheme[];
}

export async function searchAnimeThemes(
  query: string
): Promise<AnimeThemesResult | null> {
  const params = new URLSearchParams({
    q: query,
    fields: [
      "anime[name,slug]",
      "animethemes[type,sequence,slug]",
      "animethemeentries[episodes]",
      "videos[link,resolution,nc]",
      "song[title]",
      "artists[name]",
    ].join(","),
    include: [
      "animethemes.animethemeentries.videos",
      "animethemes.song.artists",
    ].join(","),
    limit: "1",
  });

  const res = await fetch(
    `${ANIMETHEMES_API}/search?${params.toString()}`,
    {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    }
  );
  if (!res.ok) throw new Error(`AnimeThemes error: ${res.status}`);

  const json = (await res.json()) as {
    search: { anime: ATAnime[] };
  };

  const animeList = json.search?.anime ?? [];
  if (!animeList.length) return null;

  const anime = animeList[0]!;

  const themes: AnimeTheme[] = (anime.animethemes ?? []).map(
    (t): AnimeTheme => {
      // Pega melhor vídeo (maior resolução)
      const allVideos = t.animethemeentries.flatMap((e) => e.videos);
      const sorted = allVideos.sort(
        (a, b) => (b.resolution ?? 0) - (a.resolution ?? 0)
      );
      const mainVideo = sorted.find((v) => !v.nc) ?? sorted[0] ?? null;
      const ncVideo = sorted.find((v) => v.nc) ?? null;

      // Episódios do primeiro entry disponível
      const episodes =
        t.animethemeentries[0]?.episodes ?? null;

      return {
        type: t.type,
        sequence: t.sequence,
        slug: t.slug,
        songTitle: t.song?.title ?? "Desconhecido",
        artists: (t.song?.artists ?? []).map((a) => a.name),
        episodes,
        videoUrl: mainVideo?.link ?? null,
        videoNC: ncVideo?.link ?? null,
      };
    }
  );

  // Ordena: OPs primeiro, depois EDs, por sequência
  themes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "OP" ? -1 : 1;
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  });

  return {
    animeName: anime.name,
    animeSlug: anime.slug,
    themes,
  };
}
