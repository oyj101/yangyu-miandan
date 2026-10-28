import express, { Application } from "express";
import cors from "cors";
import { logger } from "./lib/logger";
import { requestId } from "./middleware/requestId";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { corsOptions } from "./middleware/cors";
import { federate } from "./middleware/federation";
import { tenantContext } from "./middleware/tenant";
import { cardRouter } from "./features/card/card.controller";
import { enrollmentRouter } from "./features/enrollment/enrollment.controller";
import { checkinRouter } from "./features/checkin/checkin.controller";
import { rewardRouter } from "./features/reward/reward.controller";
import { authRouter } from "./features/auth/auth.controller";
import { periodRouter } from "./features/period/period.controller";
import { merchantRouter } from "./features/merchant/merchant.controller";
import { notifyRouter } from "./features/notify/notify.controller";
import { catalogRouter } from "./features/catalog/catalog.controller";
import { submissionRouter } from "./features/submission/submission.controller";
import { deliveryRouter } from "./features/delivery/delivery.controller";
import { sdkRouter } from "./features/sdk/sdk.controller";

/**
 * 服务定位：**纯 API**。
 *
 * 2026-10-20 起本服务不再对外提供任何页面：
 *   - `public/` 已移出部署树（legacy/standalone/ 仅存档，不参与运行）；
 *   - `express.static` 已移除 —— 留着的风险是「以为下线了，其实还能访问」，
 *     站点下线必须是真下线（同「删配置 ≠ 退役，要验运行时」的教训）。
 *
 * C 端 / 商户端 / 运营端全部改为内联 SDK 形态（sdk/octo-yangyu.v2.0.0.js），
 * 挂在既有联邦站页面上，身份走 .ws.hi.cn cookie + 主站 /auth/me。
 */
const SDK_PREFIX = "/yangyu-api";

export function createApp(): Application {
  const app = express();

  // 反代来源：nginx /yangyu-api/* → 本服务。这里自带前缀剥离，
  // 不依赖 nginx `proxy_pass` 的尾斜杠写法（那是运维侧最易漂移的一处）。
  app.use((req, _res, next) => {
    if (req.url === SDK_PREFIX || req.url.startsWith(SDK_PREFIX + "/")) {
      req.url = req.url.slice(SDK_PREFIX.length) || "/";
    }
    next();
  });

  app.use(cors(corsOptions));
  // 预检不进业务中间件链（federate 会打 8100，预检白跑一次）
  app.options("*", cors(corsOptions));

  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  // 租户上下文：Host/Origin 推导归属（不认客户端自报头），失败按 TENANT_ENFORCE 决定拒或放
  // 放在 federate 之前：它是纯归属判定，不依赖身份；先判定，后续日志与业务都能拿到 req.tenant
  app.use(tenantContext);
  // [Task-193] 联邦统一身份：解析 ai 站 token -> 主站 /auth/me -> 本地域档案
  app.use(federate);

  app.get("/health", (_req, res) =>
    res.json({ code: 0, message: "ok", ok: true, data: { status: "up" } })
  );
  app.get("/ready", (_req, res) =>
    res.json({ code: 0, message: "ok", ok: true, data: { status: "ready" } })
  );

  // SDK 聚合层（内联 SDK 的唯一入口，放在原子端点之前便于一眼看出主入口）
  app.use("/api/sdk", sdkRouter);

  app.use("/api/cards", cardRouter);
  app.use("/api/enrollments", enrollmentRouter);
  app.use("/api/checkin", checkinRouter);
  app.use("/api/reward", rewardRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/periods", periodRouter);
  app.use("/api/merchant", merchantRouter);
  app.use("/api/notify", notifyRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/submissions", submissionRouter);
  // 配送分支（009）：到店自提走 /api/checkin，配送到家走 /api/delivery
  app.use("/api/delivery", deliveryRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info("应用已装配（API-only，页面由内联 SDK 提供）");
  return app;
}
