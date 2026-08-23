import { Router, type IRouter } from "express";
import { GetCurrentSeasonResponse } from "@workspace/api-zod";
import { getSeasonCatalog } from "./season-service";

const router: IRouter = Router();


router.get("/season/current", async (_req, res) => {
  try {
    const data = GetCurrentSeasonResponse.parse(await getSeasonCatalog());
    res.json(data);
  } catch (error) {
    _req.log.error({ err: error }, "Failed to load seasonal catalog");
    res.status(502).json({ error: "Não foi possível carregar a temporada agora." });
  }
});

export default router;