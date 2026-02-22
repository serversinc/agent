import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { Hono } from "hono";
import crypto from "crypto";

// Set env vars before importing code that reads config
process.env.SERVER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

import { createServer } from "../helpers/createServer";
import { SignJWT } from "jose";

describe("jwtAuthMiddleware integration", () => {
  let closeFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeFn) await closeFn();
    closeFn = null;
  });

  it("accepts a request signed with a generated Ed25519 keypair", async () => {
    // generate ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    // export public key as SPKI PEM for config
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.PUBLIC_KEY = pubPem;

    // import middleware AFTER setting PUBLIC_KEY so config/importSPKI resolves correctly
    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");

    const app = new Hono();
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    closeFn = s.close;

    const ts = Math.floor(Date.now() / 1000);
    const body = { hello: "world" };
    const raw = JSON.stringify(body);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    const jwt = await new SignJWT({ ts, body_hash: hash })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("serversinc")
      .setAudience(`agent:${process.env.SERVER_ID}`)
      .sign(privateKey as any);

    const res = await request(s.server)
      .post("/test")
      .set("authorization", `Bearer ${jwt}`)
      .set("x-request-timestamp", String(ts))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a request signed with a different key", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.PUBLIC_KEY = pubPem;

    // import middleware AFTER setting PUBLIC_KEY so config/importSPKI resolves correctly
    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");

    const app = new Hono();
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    closeFn = s.close;

    const ts = Math.floor(Date.now() / 1000);
    const body = { foo: "bar" };
    const raw = JSON.stringify(body);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    // sign with a different key: generate second keypair and use its privateKey
    const { privateKey: otherPriv } = crypto.generateKeyPairSync("ed25519");

    const jwt = await new SignJWT({ ts, body_hash: hash })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("serversinc")
      .setAudience(`agent:${process.env.SERVER_ID}`)
      .sign(otherPriv as any);

    const res = await request(s.server)
      .post("/test")
      .set("authorization", `Bearer ${jwt}`)
      .set("x-request-timestamp", String(ts))
      .send(body);

    expect(res.status).toBe(401);

    // close server
    await s.close();
  });
});
