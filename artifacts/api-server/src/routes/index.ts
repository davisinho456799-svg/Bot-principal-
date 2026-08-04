import { Router, type IRouter } from "express";
import healthRouter from "./health";
import subscriptionsRouter from "./subscriptions";
import errorsRouter from "./errors";

const router: IRouter = Router();

router.use(healthRouter);
router.use(subscriptionsRouter);
router.use(errorsRouter);

export default router;
