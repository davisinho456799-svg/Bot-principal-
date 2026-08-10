export type MangaSource =
  | "comick"
  | "mangaupdates"
  | "mangadex"
  | "jikan"
  | "anilist";

export type MangaStatus =
  | "RELEASING"
  | "FINISHED"
  | "HIATUS"
  | "CANCELLED"
  | "NOT_YET_RELEASED"
  | string;

export interface MangaRecord {
  source: MangaSource;
  id: string;
  title: string;
  alternativeTitles: string[];
  description: string | null;
  coverUrl: string | null;
  score: number | null;
  genres: string[];
  status: MangaStatus | null;
  chapters: number | null;
  year: number | null;
  country: string | null;
  url: string;
}

export interface ChapterRecord {
  id: string;
  chapter: string;
  volume: string | null;
  title: string | null;
  language: string | null;
  publishedAt: string | null;
  url: string | null;
  group: string | null;
  source: "comick" | "mangadex";
}

export interface SourceStatus {
  source: MangaSource;
  status: "ok" | "empty" | "error";
  count: number;
  error?: string;
}

export interface MangaAggregate {
  query: string;
  primarySource: "comick";
  results: MangaRecord[];
  sources: SourceStatus[];
}