import { parseWithPlatformMarkup } from "./parser-utils";
import type { ChapterParser, ParsedChapter, ParserContext } from "./parser-types";

export class LezhinParser implements ChapterParser {
  readonly name = "LezhinParser";

  async parse(context: ParserContext): Promise<ParsedChapter[]> {
    return parseWithPlatformMarkup({ ...context, platform: "lezhin" });
  }
}

export type { ParsedChapter };