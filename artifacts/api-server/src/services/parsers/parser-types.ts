export type MonitorPlatform = "lezhin" | "toomics" | "toptoon";

export type ParserContext = {
  listingUrl: string;
  platform: MonitorPlatform;
  workTitle: string;
};

export type ParsedChapter = {
  number: string;
  thumbnailUrl: string;
  /**
   * Date shown by the source card, when the platform exposes one.
   * It is used only to prevent a parser migration from publishing history.
   */
  releaseDate?: string;
};

export interface ChapterParser {
  readonly name: string;
  parse(context: ParserContext): Promise<ParsedChapter[]>;
}