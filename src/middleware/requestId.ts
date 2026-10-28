import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

export const REQUEST_ID_HEADER = "x-request-id";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers[REQUEST_ID_HEADER] as string) || randomUUID();
  (req as any).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
