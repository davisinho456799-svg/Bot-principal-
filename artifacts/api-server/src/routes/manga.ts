import { Router, type IRouter } from "express";
import { searchMangaAggregate } from "../manga/aggregator";
import { getComickChapters } from "../manga/providers/comick";

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

export default router;