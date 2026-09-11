import { parseWithPlatformMarkup } from "./parser-utils";
import type { ChapterParser, ParsedChapter, ParserContext } from "./parser-types";

export class ToptoonParser implements ChapterParser {
  readonly name = "ToptoonParser";

  async parse(context: ParserContext): Promise<ParsedChapter[]> {
    return parseWithPlatformMarkup({ ...context, platform: "toptoon" });
  }
}

export type { ParsedChapter };