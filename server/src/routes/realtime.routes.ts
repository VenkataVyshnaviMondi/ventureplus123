import { Router } from "express";
import type { Request, Response } from "express";
import { extractToken, requireAuth } from "../middleware/auth.js";
import { subscribeAuthorized } from "../realtime/authorizedEvents.js";

const router = Router();

router.get("/stream", requireAuth, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);

  const unsubscribe = subscribeAuthorized(extractToken(req), (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }, () => res.end());

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
