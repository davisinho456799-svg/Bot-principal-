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

export interface MangaUpdatesGroup {
  id: string | null;
  name: string;
  url: string | null;
}

export interface MangaUpdatesSeries extends MangaRecord {
  source: "mangaupdates";
  sourceRole: "metadata-and-releases";
  latestChapter: number | null;
  statusText: string | null;
  alternativeTitles: string[];
  groups: MangaUpdatesGroup[];
  lastUpdated: string | null;
}

export interface MangaUpdatesRelease {
  id: string;
  title: string;
  volume: string | null;
  chapter: string;
  groups: MangaUpdatesGroup[];
  releaseDate: string | null;
  addedAt: string | null;
  url: string;
}

export interface MangaUpdatesTrackingSnapshot {
  source: "mangaupdates";
  seriesId: string;
  title: string;
  latestChapter: number | null;
  status: string | null;
  statusText: string | null;
  lastUpdated: string | null;
  checkedAt: string;
  chaptersAreOfficialSource: false;
}