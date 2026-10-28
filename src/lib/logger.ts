import pino from "pino";

export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { service: "yangyu-miandan" },
  redact: ["req.headers.authorization", "password", "secret", "token"],
});

export type Logger = typeof logger;
