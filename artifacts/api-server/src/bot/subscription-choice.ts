export type SubscriptionKind = "anime" | "manga" | "manhwa";

export type SubscriptionChoice =
  | {
      kind: "anime";
      source: "anilist-anime" | "jikan" | "tenrai" | "kitsu" | "vndb" | "erogamescape";
      id: string;
    }
  | {
      kind: "manga";
      source: "anilist" | "comick" | "mangadex" | "mangaupdates" | "jikan" | "tenrai" | "vndb" | "erogamescape";
      id: string;
    };

function splitChoice(value: string): { source: string; id: string } | null {
  const match = /^([a-z-]+):([^\s]+)$/.exec(value);
  return match ? { source: match[1]!, id: match[2]! } : null;
}

/** Validate a source returned by /assinar autocomplete against its selected media type. */
export function parseSubscriptionChoice(tipo: SubscriptionKind, value: string): SubscriptionChoice | null {
  const choice = splitChoice(value);
  if (!choice) return null;

  if (tipo === "anime") {
    if (choice.source === "anilist-anime" || choice.source === "jikan" ||
        choice.source === "tenrai" || choice.source === "kitsu") {
      return { kind: "anime", source: choice.source, id: choice.id };
    }
    return null;
  }

  if (choice.source === "anilist" || choice.source === "comick" ||
      choice.source === "mangadex" || choice.source === "mangaupdates" ||
      choice.source === "jikan" || choice.source === "tenrai") {
    return { kind: "manga", source: choice.source, id: choice.id };
  }
  return null;
}

/** Accept the existing +18 catalog sources while enforcing anime/manga routing. */
export function parseAdultSubscriptionChoice(
  tipo: SubscriptionKind,
  value: string,
): SubscriptionChoice | null {
  const choice = splitChoice(value);
  if (!choice) return null;

  if (tipo === "anime") {
    if (choice.source === "anilist-anime") {
      return { kind: "anime", source: choice.source, id: choice.id };
    }
    if (choice.source === "jikan" || choice.source === "jikan-anime") {
      return { kind: "anime", source: "jikan", id: choice.id };
    }
    if (choice.source === "tenrai" || choice.source === "kitsu" ||
        choice.source === "vndb" || choice.source === "erogamescape") {
      return { kind: "anime", source: choice.source, id: choice.id };
    }
    return null;
  }

  if (choice.source === "anilist" || choice.source === "comick" ||
      choice.source === "mangadex" || choice.source === "mangaupdates" ||
      choice.source === "jikan" || choice.source === "tenrai" ||
      choice.source === "vndb" || choice.source === "erogamescape") {
    return { kind: "manga", source: choice.source, id: choice.id };
  }
  return null;
}
