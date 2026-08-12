import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { recordError, requestErrorContext } from "./lib/error-logging";

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

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode < 400 || res.locals.errorLogged === true) {
      return originalJson(body);
    }

    res.locals.errorLogged = true;
    void recordError({
      ...requestErrorContext(req),
      errorCode: res.statusCode >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR",
      message:
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `API request failed with HTTP ${res.statusCode}.`,
      httpStatus: res.statusCode,
    })
      .then((errorLog) => {
        originalJson({
          ...(typeof body === "object" && body !== null ? body : {}),
          error_id: errorLog.id,
        });
      })
      .catch((loggingError: unknown) => {
        res.locals.errorLogged = false;
        req.log.error({ loggingError }, "Failed to persist API error history");
        originalJson(body);
      });
    return res;
  }) as typeof res.json;
  next();
});

// Keep a server-side history for every failed API response, including
// validation errors and unknown routes that do not reach a domain handler.
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode < 400 || res.locals.errorLogged === true) {
      return;
    }

    void recordError({
      ...requestErrorContext(req),
      errorCode: res.statusCode >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR",
      message: `API request failed with HTTP ${res.statusCode}.`,
      httpStatus: res.statusCode,
    }).catch((loggingError: unknown) => {
      req.log.error({ loggingError }, "Failed to persist API error history");
    });
  });
  next();
});

// Render's default health check targets the root path. Keep it healthy even
// when the service is not configured with the more specific /api/healthz path.
app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", router);

app.use(async (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = 500;
  const message = err instanceof Error ? err.message : "Erro interno do servidor.";
  try {
    const errorLog = await recordError({
      ...requestErrorContext(req),
      errorCode: "INTERNAL_SERVER_ERROR",
      message,
      httpStatus: status,
    });
    res.locals.errorLogged = true;
    req.log.error({ err, errorId: errorLog.id }, "Unhandled API error");
    res.status(status).json({ error: message, error_id: errorLog.id });
  } catch (loggingError) {
    req.log.error({ err, loggingError }, "Unhandled API error and error logging failed");
    res.status(status).json({ error: message });
  }
});

export default app;
