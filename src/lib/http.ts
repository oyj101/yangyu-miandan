import { Response } from "express";

/**
 * 统一信封（平台契约：{code, message, data}）
 *
 * 为什么要带 code：内联 SDK 的 `Octo.api.request` 按 `payload.code` 判定成功，
 * 非 0 直接抛 OctoError。此前本服务只回 `{ok, data}`，SDK 会把整个包原样当 data 返回，
 * 于是每个调用点都得手写 `.data`，一漏就是空渲染。
 *
 * 为什么同时保留 ok/error：`src/integration-test.ts` 与线上存量宿主页按 `ok`/`error` 断言。
 * 双写只多十几字节，换来「换信封不改任何调用方」，比一次性破坏性改名划算。
 * code 语义：0 = 成功；非 0 = HTTP 状态码（2001 = 登录态失效，SDK 侧约定）。
 */
export function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ code: 0, message: "ok", ok: true, data });
}

export function created<T>(res: Response, data: T) {
  res.status(201).json({ code: 0, message: "ok", ok: true, data });
}

export function page<T>(res: Response, items: T[], total: number, page: number, pageSize: number) {
  res.status(200).json({
    code: 0,
    message: "ok",
    ok: true,
    data: { items, total, page, pageSize },
  });
}
