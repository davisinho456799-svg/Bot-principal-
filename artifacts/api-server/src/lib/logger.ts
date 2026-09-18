import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return error;
  return {
    type: error.constructor.name,
    message: error.message,
    stack: error.stack?.replace(/\r?\n/g, " | "),
    ...(error.cause ? { cause: error.cause } : {}),
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: serializeError,
  },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
