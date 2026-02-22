import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "./createServer";
import type { Server } from "http";

export type MakeAppOptions = {
  auth?: boolean; // whether to attach jwt auth middleware (default true)
  requestId?: boolean; // whether to attach request-id middleware (default true)
};

export async function makeApp(register: (app: Hono) => void, opts: MakeAppOptions = {}) {
  const app = new Hono();

  app.use(cors());

  if (opts.requestId ?? true) {
    // simple request-id middleware similar to server implementation
    app.use("*", async (ctx, next) => {
      const requestId = ctx.req.header("x-request-id") || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // @ts-ignore - set is used by some handlers
      ctx.set("request-id", requestId);
      await next();
    });
  }

  // Only attach auth middleware if explicitly requested. This avoids importing
  // application config (which validates env) in tests that don't need auth.
  if (opts.auth === true) {
    // import middleware dynamically so callers can set process.env before calling makeApp
    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");
    app.use("*", jwtAuthMiddleware);
  }

  register(app);

  const s = createServer(app);

  return { app, server: s.server as Server, close: s.close };
}
