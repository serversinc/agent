import type { Context } from "hono";

export function healthHandler(ctx: Context): Response {
  return ctx.json({ status: "ok" });
}
