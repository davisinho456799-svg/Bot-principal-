import { logger } from "./logger";

const MAL_API_BASE = "https://api.myanimelist.net/v2";
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID ?? "";

export interface MalItemData {
  synopsis: string | null;
  score: number | null;
  status: string | null;
  chapters: number | null;
}

export async function fetchMalItem(
  malItemId: number,
  malItemType: "manga" | "anime",
): Promise<MalItemData> {
  if (!MAL_CLIENT_ID) {
    throw new Error(
      "MAL_CLIENT_ID not configured. Set it as a secret in your environment.",
    );
  }

  const fields =
    malItemType === "manga"
      ? "synopsis,mean,status,num_chapters"
      : "synopsis,mean,status,num_episodes";

  const url = `${MAL_API_BASE}/${malItemType}/${malItemId}?fields=${fields}`;

  const response = await fetch(url, {
    headers: {
      "X-MAL-CLIENT-ID": MAL_CLIENT_ID,
    },
  });

  if (!response.ok) {
    logger.warn(
      { status: response.status, malItemId, malItemType },
      "MAL API request failed",
    );
    throw new Error(`MAL API returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  const chapters =
    malItemType === "manga"
      ? (data["num_chapters"] as number | null | undefined) ?? null
      : (data["num_episodes"] as number | null | undefined) ?? null;

  return {
    synopsis: (data["synopsis"] as string | null | undefined) ?? null,
    score: (data["mean"] as number | null | undefined) ?? null,
    status: (data["status"] as string | null | undefined) ?? null,
    chapters: chapters === 0 ? null : chapters,
  };
}
