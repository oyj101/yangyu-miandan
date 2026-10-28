import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { unauthorized } from "../lib/errors";
import { logger } from "../lib/logger";

export type Role = "USER" | "MERCHANT" | "OPERATOR" | "CASHIER";

export interface AuthUser {
  userId: string;
  role: Role;
  merchantId?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    requestId?: string;
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(user as object, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl,
  });
}

export function signRefreshToken(user: AuthUser): string {
  return jwt.sign({ ...user, typ: "refresh" }, config.jwt.secret, {
    expiresIn: config.jwt.refreshTtl,
  });
}

export function auth(roles?: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // [Task-193] 联邦统一身份优先：federate 中间件已验过主站 /auth/me 并挂 req.fedUser
    if (req.fedUser) {
      if (roles && roles.length && !roles.includes(req.fedUser.role)) {
        logger.warn(
          { userId: req.fedUser.userId, role: req.fedUser.role, need: roles, via: "federated" },
          "RBAC 拒绝"
        );
        return next(unauthorized("角色无权访问"));
      }
      req.user = {
        userId: req.fedUser.userId,
        role: req.fedUser.role,
        merchantId: req.fedUser.merchantId,
      };
      return next();
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(unauthorized("缺少访问令牌"));
    }
    const token = header.slice(7);
    try {
      const payload = jwt.verify(token, config.jwt.secret) as AuthUser & { typ?: string };
      if (payload.typ === "refresh") {
        return next(unauthorized("刷新令牌不能用于访问接口"));
      }
      const user: AuthUser = {
        userId: payload.userId,
        role: payload.role,
        merchantId: payload.merchantId,
      };
      if (roles && roles.length && !roles.includes(user.role)) {
        logger.warn({ userId: user.userId, role: user.role, need: roles }, "RBAC 拒绝");
        return next(unauthorized("角色无权访问"));
      }
      req.user = user;
      next();
    } catch (err) {
      logger.warn({ err }, "令牌校验失败");
      next(unauthorized("令牌无效或已过期"));
    }
  };
}
