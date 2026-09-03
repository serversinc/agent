import type { Context } from "hono";
import config from "../config";

export function healthHandler(ctx: Context): Response {
  return ctx.json({ status: "ok", version: config.AGENT_VERSION });
}
