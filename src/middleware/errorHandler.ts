import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * 错误信封：`{ code:<http>, message, ok:false, error:{...} }`
 *
 * - `code` 数字给 SDK（core 按 code !== 0 抛 OctoError，非 ok 响应还会读 message 作文案）；
 * - `error` 对象给存量宿主页与联调脚本（它们断言 `body.error.message`）；
 * - 两者同源，不可能漂移。
 */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    code: 404,
    message: "接口不存在",
    ok: false,
    error: { code: "NOT_FOUND", message: "接口不存在" },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    logger.warn({ requestId: req.requestId, issues: err.issues }, "参数校验失败");
    return res.status(422).json({
      code: 422,
      message: "参数校验失败",
      ok: false,
      error: { code: "VALIDATION", message: "参数校验失败", details: err.issues },
    });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ requestId: req.requestId, err }, "业务错误(5xx)");
    return res.status(err.status).json({
      code: err.status,
      message: err.message,
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  logger.error({ requestId: req.requestId, err }, "未捕获异常");
  return res.status(500).json({
    code: 500,
    message: "服务器内部错误",
    ok: false,
    error: { code: "INTERNAL", message: "服务器内部错误" },
  });
}
