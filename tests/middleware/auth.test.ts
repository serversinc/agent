import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { Hono } from "hono";
import crypto from "crypto";

// Mock config before importing the middleware so the module uses our test values
vi.mock("../../src/config", () => ({
  default: {
    PUBLIC_KEY: "TEST_PUBLIC_KEY",
    SERVER_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  },
  __esModule: true,
}));

// Mock jose so we can control verification behaviour
vi.mock("jose", () => ({
  importSPKI: vi.fn(() => Promise.resolve("PUBLIC_KEY_OBJ")),
  jwtVerify: vi.fn(),
}));

import { createServer } from "../helpers/createServer";
import { jwtAuthMiddleware } from "../../src/middleware/auth";
import * as jose from "jose";

describe("jwtAuthMiddleware", () => {
  let server: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(() => {
    // reset mock behaviour between tests
    vi.resetAllMocks();
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", jwtAuthMiddleware);
    app.post("/test", async ctx => ctx.json({ ok: true }));

    const s = createServer(app);
    server = s.server;
    closeFn = s.close;
    return s;
  }

  it("returns 401 when Authorization header is missing or malformed", async () => {
    const s = makeApp();

    const res = await request(s.server).post("/test").send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for invalid timestamp header", async () => {
    const s = makeApp();

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", "not-a-number").send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid timestamp");
  });

  it("returns 401 for expired request", async () => {
    const s = makeApp();

    const oldTs = Math.floor(Date.now() / 1000) - 100; // beyond CLOCK_SKEW_SECONDS

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(oldTs)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Expired request");
  });

  it("returns 401 when jwtVerify throws", async () => {
    const s = makeApp();

    (jose as any).jwtVerify.mockRejectedValue(new Error("bad token"));

    const ts = Math.floor(Date.now() / 1000);

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for payload ts mismatch", async () => {
    const s = makeApp();

    (jose as any).jwtVerify.mockResolvedValue({ payload: { ts: 1, body_hash: "abc" } });

    const ts = Math.floor(Date.now() / 1000);

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid timestamp");
  });

  it("returns 401 for missing body_hash", async () => {
    const s = makeApp();

    const ts = Math.floor(Date.now() / 1000);
    (jose as any).jwtVerify.mockResolvedValue({ payload: { ts } });

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Malformed request body");
  });

  it("returns 401 for body hash mismatch", async () => {
    const s = makeApp();

    const ts = Math.floor(Date.now() / 1000);
    (jose as any).jwtVerify.mockResolvedValue({ payload: { ts, body_hash: "wronghash" } });

    const body = { hello: "world" };

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Malformed request body");
  });

  it("allows request when token and body hash match", async () => {
    const s = makeApp();

    const ts = Math.floor(Date.now() / 1000);
    const body = { a: 1 };
    const raw = JSON.stringify(body);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    (jose as any).jwtVerify.mockResolvedValue({ payload: { ts, body_hash: hash } });

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ensure server is closed after each test to avoid open handles
  afterEach(async () => {
    if (closeFn) await closeFn();
    closeFn = null;
  });
});
