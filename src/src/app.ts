import express, { Application } from "express";
import path from "path";
import cors from "cors";
import { config } from "./config";
import { logger } from "./lib/logger";
import { requestId } from "./middleware/requestId";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { federate } from "./middleware/federation";
import { cardRouter } from "./features/card/card.controller";
import { enrollmentRouter } from "./features/enrollment/enrollment.controller";
import { checkinRouter } from "./features/checkin/checkin.controller";
import { rewardRouter } from "./features/reward/reward.controller";
import { authRouter } from "./features/auth/auth.controller";

export function createApp(): Application {
  const app = express();

  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : false,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  // [Task-193] 联邦统一身份：解析 ai 站 token -> 主站 /auth/me -> 本地域档案
  app.use(federate);
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/health", (_req, res) => res.json({ ok: true, status: "up" }));
  app.get("/ready", (_req, res) => res.json({ ok: true, status: "ready" }));

  app.use("/api/cards", cardRouter);
  app.use("/api/enrollments", enrollmentRouter);
  app.use("/api/checkin", checkinRouter);
  app.use("/api/reward", rewardRouter);
  app.use("/api/auth", authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info("应用已装配");
  return app;
}
