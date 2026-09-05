import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const frontendCandidates = process.env.FRONTEND_DIST_DIR
  ? [path.resolve(process.env.FRONTEND_DIST_DIR)]
  : [
      path.resolve(process.cwd(), "artifacts/chapter-monitor/dist/public"),
      path.resolve(process.cwd(), "../chapter-monitor/dist/public"),
    ];
const frontendDist =
  frontendCandidates.find((candidate) => existsSync(candidate)) ??
  frontendCandidates[0];
const shouldServeFrontend =
  process.env.SERVE_FRONTEND === "true" || process.env.NODE_ENV === "production";

if (shouldServeFrontend && existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }

    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

export default app;
