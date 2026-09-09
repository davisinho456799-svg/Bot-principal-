import { parseWithPlatformMarkup } from "./parser-utils";
import type { ChapterParser, ParsedChapter, ParserContext } from "./parser-types";

export class ToomicsParser implements ChapterParser {
  readonly name = "ToomicsParser";

  async parse(context: ParserContext): Promise<ParsedChapter[]> {
    return parseWithPlatformMarkup({ ...context, platform: "toomics" });
  }
}

export type { ParsedChapter };