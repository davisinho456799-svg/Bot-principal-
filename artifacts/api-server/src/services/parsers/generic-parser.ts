import { fetchPageHtml, parseGenericChapterHtml } from "./parser-utils";
import type { ChapterParser, ParsedChapter, ParserContext } from "./parser-types";

export class GenericParser implements ChapterParser {
  readonly name = "GenericParser";

  async parse(context: ParserContext): Promise<ParsedChapter[]> {
    const html = await fetchPageHtml(context.listingUrl, context.platform);
    return parseGenericChapterHtml(html, context.listingUrl);
  }
}