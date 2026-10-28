export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError("BAD_REQUEST", msg, 400, details);
export const unauthorized = (msg = "未认证") => new AppError("UNAUTHORIZED", msg, 401);
export const forbidden = (msg = "无权限") => new AppError("FORBIDDEN", msg, 403);
export const notFound = (msg = "资源不存在") => new AppError("NOT_FOUND", msg, 404);
export const conflict = (msg: string, details?: unknown) =>
  new AppError("CONFLICT", msg, 409, details);
export const validationError = (msg: string, details?: unknown) =>
  new AppError("VALIDATION", msg, 422, details);
export const internal = (msg = "服务器内部错误") => new AppError("INTERNAL", msg, 500);
