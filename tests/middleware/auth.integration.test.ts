import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { Hono } from "hono";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Set env vars before importing code that reads config
process.env.SERVER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

import { createServer } from "../helpers/createServer";
import { SignJWT } from "jose";

// config.PUBLIC_KEY is loaded from a file at PUBLIC_KEY_PATH, not from a
// PUBLIC_KEY env var directly — so the generated test keypair has to be
// written to disk and pointed at via PUBLIC_KEY_PATH for the middleware to
// actually verify against it.
function writePublicKeyToTempFile(pem: string): string {
  const filePath = path.join(os.tmpdir(), `agent-test-public-key-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
  fs.writeFileSync(filePath, pem);
  return filePath;
}

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
    process.env.PUBLIC_KEY_PATH = writePublicKeyToTempFile(pubPem);

    // import middleware AFTER setting PUBLIC_KEY_PATH so config/importSPKI resolves correctly
    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");

    const app = new Hono();
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    closeFn = s.close;

    const ts = Math.floor(Date.now() / 1000);
    const body = { hello: "world" };

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("serversinc/core")
      .setAudience(`agent:${process.env.SERVER_ID}`)
      .setIssuedAt(ts)
      .sign(privateKey as any);

    const res = await request(s.server).post("/test").set("authorization", `Bearer ${jwt}`).set("x-request-timestamp", String(ts)).send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a request signed with a different key", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.PUBLIC_KEY_PATH = writePublicKeyToTempFile(pubPem);

    // import middleware AFTER setting PUBLIC_KEY_PATH so config/importSPKI resolves correctly.
    // Note: the module is already cached from the previous test's import (same specifier), so
    // this re-import intentionally reuses that instance — irrelevant here since this test signs
    // with a mismatched key regardless and expects rejection either way.
    const { jwtAuthMiddleware } = await import("../../src/middleware/auth");

    const app = new Hono();
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    closeFn = s.close;

    const ts = Math.floor(Date.now() / 1000);
    const body = { foo: "bar" };

    // sign with a different key: generate second keypair and use its privateKey
    const { privateKey: otherPriv } = crypto.generateKeyPairSync("ed25519");

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("serversinc/core")
      .setAudience(`agent:${process.env.SERVER_ID}`)
      .setIssuedAt(ts)
      .sign(otherPriv as any);

    const res = await request(s.server).post("/test").set("authorization", `Bearer ${jwt}`).set("x-request-timestamp", String(ts)).send(body);

    expect(res.status).toBe(401);

    // close server
    await s.close();
  });
});
