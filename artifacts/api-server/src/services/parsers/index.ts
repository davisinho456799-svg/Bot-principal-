import { GenericParser } from "./generic-parser";
import { LezhinParser } from "./lezhin-parser";
import { ToomicsParser } from "./toomics-parser";
import { ToptoonParser } from "./toptoon-parser";
import type { ChapterParser, MonitorPlatform } from "./parser-types";

const specificParsers: Record<MonitorPlatform, ChapterParser> = {
  lezhin: new LezhinParser(),
  toomics: new ToomicsParser(),
  toptoon: new ToptoonParser(),
};

export const genericParser = new GenericParser();

export function parserForPlatform(platform: string): ChapterParser | null {
  return specificParsers[platform as MonitorPlatform] ?? null;
}

export type { ChapterParser, MonitorPlatform, ParsedChapter, ParserContext } from "./parser-types";
export { buildChapterKey } from "./parser-utils";