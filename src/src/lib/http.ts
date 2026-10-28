import { Response } from "express";

export function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ ok: true, data });
}

export function created<T>(res: Response, data: T) {
  res.status(201).json({ ok: true, data });
}

export function page<T>(res: Response, items: T[], total: number, page: number, pageSize: number) {
  res.status(200).json({ ok: true, data: { items, total, page, pageSize } });
}
