import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    logger.warn({ requestId: req.requestId, issues: err.issues }, "参数校验失败");
    return res.status(422).json({
      ok: false,
      error: { code: "VALIDATION", message: "参数校验失败", details: err.issues },
    });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ requestId: req.requestId, err }, "业务错误(5xx)");
    return res.status(err.status).json({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  logger.error({ requestId: req.requestId, err }, "未捕获异常");
  return res.status(500).json({
    ok: false,
    error: { code: "INTERNAL", message: "服务器内部错误" },
  });
}
