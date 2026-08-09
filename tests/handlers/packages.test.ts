import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createPackageHandlers } from "../../src/controllers/packages";
import { makeApp } from "../helpers/makeApp";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Package Handlers", () => {
  let server: import("http").Server;
  let mockPackageService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockPackageService = { install: vi.fn() };
    const handlers = createPackageHandlers(mockPackageService);

    const s = await makeApp(
      app => {
        app.post("/packages/install", handlers.install);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  it("installs a package", async () => {
    mockPackageService.install.mockResolvedValue({ output: "Setting up fail2ban", error: "", exitCode: 0 });

    const response = await request(server).post("/packages/install").send({ package: "fail2ban" });

    expect(response.status).toBe(200);
    expect(response.body.exitCode).toBe(0);
    expect(mockPackageService.install).toHaveBeenCalledWith("fail2ban");
  });

  it("returns 400 for an invalid package name", async () => {
    mockPackageService.install.mockRejectedValue(new Error("Invalid package name: ; rm -rf /"));

    const response = await request(server).post("/packages/install").send({ package: "; rm -rf /" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid package name/);
  });

  it("returns 500 on unexpected install failure", async () => {
    mockPackageService.install.mockRejectedValue(new Error("apt-get lock held"));

    const response = await request(server).post("/packages/install").send({ package: "fail2ban" });

    expect(response.status).toBe(500);
  });
});
