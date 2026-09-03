import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { Hono } from "hono";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

process.env.SERVER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

import { createServer } from "../helpers/createServer";

function writePublicKeyToTempFile(pem: string): string {
  const filePath = path.join(os.tmpdir(), `agent-test-public-key-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
  fs.writeFileSync(filePath, pem);
  return filePath;
}

// Mirrors the route registration order in Server.ts: /health is registered
// before the auth middleware so it never enters that chain — a self-updating
// container has no control-plane token to present when checking itself.
describe("/health route", () => {
  let closeFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeFn) await closeFn();
    closeFn = null;
  });

  it("responds without auth headers, while other routes still require them", async () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.PUBLIC_KEY_PATH = writePublicKeyToTempFile(pubPem);

    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");
    const { healthHandler } = await import("../../src/controllers/health");

    const app = new Hono();
    app.get("/health", healthHandler);
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    closeFn = s.close;

    const healthRes = await request(s.server).get("/health");
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe("ok");

    const protectedRes = await request(s.server).post("/test").send({});
    expect(protectedRes.status).toBe(401);
  });
});
