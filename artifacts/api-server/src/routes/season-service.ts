import { getCurrentSeasonData } from "./season-service-data";

export async function getSeasonCatalog() {
  return getCurrentSeasonData();
}