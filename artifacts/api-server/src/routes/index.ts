import { Router, type IRouter } from "express";
import healthRouter from "./health";
import seasonRouter from "./season";
import discordRouter from "./discord";

const router: IRouter = Router();

router.use(healthRouter);
router.use(seasonRouter);
router.use(discordRouter);

export default router;
