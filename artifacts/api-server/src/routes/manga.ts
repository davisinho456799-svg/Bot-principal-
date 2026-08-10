import { Router, type IRouter } from "express";
import { searchMangaAggregate } from "../manga/aggregator";
import { getComickChapters } from "../manga/providers/comick";
import {
  getMangaUpdatesSeries,
  getMangaUpdatesTrackingSnapshot,
  searchMangaUpdates,
  searchMangaUpdatesReleases,
} from "../manga/providers/mangaupdates";

const router: IRouter = Router();

router.get("/manga/aggregate", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  if (query.length < 2) {
    res.status(400).json({ error: "query must contain at least 2 characters" });
    return;
  }

  res.json(await searchMangaAggregate(query));
});

router.get("/manga/comick/chapters", async (req, res) => {
  const slug = String(req.query.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug is required" });
    return;
  }

  try {
    const chapters = await getComickChapters(slug, {
      language: typeof req.query.language === "string" ? req.query.language : "en",
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : 100,
    });
  res.json({ source: "comick", mangaId: slug, chapters });
  } catch (error) {
    req.log.warn({ err: error, slug }, "Comick chapters request failed");
    res.status(502).json({ error: "Comick chapters are unavailable" });
  }
});

router.get("/manga/mangaupdates/search", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  if (query.length < 2) {
    res.status(400).json({ error: "query must contain at least 2 characters" });
    return;
  }

  try {
    const results = await searchMangaUpdates(query);
    res.json({ source: "mangaupdates", results });
  } catch (error) {
    req.log.warn({ err: error, query }, "MangaUpdates search failed");
    res.status(502).json({ error: "MangaUpdates search is unavailable" });
  }
});

router.get("/manga/mangaupdates/series", async (req, res) => {
  const id = String(req.query.id ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  try {
    const series = await getMangaUpdatesSeries(id);
    if (!series) {
      res.status(404).json({ error: "MangaUpdates series not found" });
      return;
    }
    res.json(series);
  } catch (error) {
    req.log.warn({ err: error, id }, "MangaUpdates series request failed");
    res.status(502).json({ error: "MangaUpdates series is unavailable" });
  }
});

router.get("/manga/mangaupdates/releases", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  if (query.length < 2) {
    res.status(400).json({ error: "query must contain at least 2 characters" });
    return;
  }

  try {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const releases = await searchMangaUpdatesReleases(query, limit);
    res.json({ source: "mangaupdates", query, releases });
  } catch (error) {
    req.log.warn({ err: error, query }, "MangaUpdates releases request failed");
    res.status(502).json({ error: "MangaUpdates releases are unavailable" });
  }
});

router.get("/manga/mangaupdates/tracking", async (req, res) => {
  const id = String(req.query.id ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  try {
    const snapshot = await getMangaUpdatesTrackingSnapshot(id);
    if (!snapshot) {
      res.status(404).json({ error: "MangaUpdates series not found" });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    req.log.warn({ err: error, id }, "MangaUpdates tracking request failed");
    res.status(502).json({ error: "MangaUpdates tracking is unavailable" });
  }
});

export default router;