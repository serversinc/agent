import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { Hono } from "hono";

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

  it("returns 401 when the x-request-timestamp header is missing", async () => {
    const s = makeApp();

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when jwtVerify throws", async () => {
    const s = makeApp();

    (jose as any).jwtVerify.mockRejectedValue(new Error("bad token"));

    const ts = Math.floor(Date.now() / 1000);

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when the token's iat does not match the request timestamp", async () => {
    const s = makeApp();

    const ts = Math.floor(Date.now() / 1000);
    (jose as any).jwtVerify.mockResolvedValue({ payload: { iat: ts - 1 } });

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("allows the request when the token's iat matches the request timestamp", async () => {
    const s = makeApp();

    const ts = Math.floor(Date.now() / 1000);
    (jose as any).jwtVerify.mockResolvedValue({ payload: { iat: ts } });

    const res = await request(s.server).post("/test").set("authorization", "Bearer token").set("x-request-timestamp", String(ts)).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ensure server is closed after each test to avoid open handles
  afterEach(async () => {
    if (closeFn) await closeFn();
    closeFn = null;
  });
});
