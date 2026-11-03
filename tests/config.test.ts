import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("config — heartbeat interval", () => {
  const original = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-config-"));
    const keyPath = join(dir, "public.pem");
    writeFileSync(keyPath, "-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----\n");

    process.env.CORE_URL = "http://localhost:3000";
    process.env.SECRET_KEY = "a".repeat(64);
    process.env.SERVER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    process.env.PUBLIC_KEY_PATH = keyPath;
    delete process.env.HEARTBEAT_INTERVAL_MS;

    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...original };
    vi.resetModules();
  });

  it("defaults the heartbeat interval to five minutes", async () => {
    const { default: config } = await import("../src/config");

    expect(config.HEARTBEAT_INTERVAL_MS).toBe(300000);
  });

  it("honours HEARTBEAT_INTERVAL_MS from the environment", async () => {
    process.env.HEARTBEAT_INTERVAL_MS = "120000";

    const { default: config } = await import("../src/config");

    expect(config.HEARTBEAT_INTERVAL_MS).toBe(120000);
  });

  it("rejects a heartbeat interval above the supported maximum", async () => {
    process.env.HEARTBEAT_INTERVAL_MS = String(60 * 60 * 1000);

    await expect(import("../src/config")).rejects.toThrow(/Configuration validation failed/);
  });
});
