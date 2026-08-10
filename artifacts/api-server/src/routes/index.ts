import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mangaRouter from "./manga";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mangaRouter);

export default router;
