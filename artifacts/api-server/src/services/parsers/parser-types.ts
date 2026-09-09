export type MonitorPlatform = "lezhin" | "toomics" | "toptoon";

export type ParserContext = {
  listingUrl: string;
  platform: MonitorPlatform;
  workTitle: string;
};

export type ParsedChapter = {
  number: string;
  thumbnailUrl: string;
};

export interface ChapterParser {
  readonly name: string;
  parse(context: ParserContext): Promise<ParsedChapter[]>;
}