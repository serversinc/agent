import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { zValidator } from "@hono/zod-validator";
import { createServiceHandlers } from "../../src/controllers/services";
import { SystemdServiceError } from "../../src/services/SystemdService";
import { serviceActionSchema, serviceJournalQuerySchema } from "../../src/validators/Services";
import { makeApp } from "../helpers/makeApp";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Service Handlers", () => {
  let server: import("http").Server;
  let mockSystemdService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockSystemdService = {
      listServices: vi.fn(),
      performAction: vi.fn(),
      getJournal: vi.fn(),
    };

    const handlers = createServiceHandlers(mockSystemdService);

    const s = await makeApp(
      app => {
        app.get("/services", handlers.list);
        app.post("/services/:unit/actions", zValidator("json", serviceActionSchema), handlers.action);
        app.get("/services/:unit/journal", zValidator("query", serviceJournalQuerySchema), handlers.journal);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
    vi.clearAllMocks();
  });

  describe("GET /services", () => {
    it("returns the structured unit list", async () => {
      mockSystemdService.listServices.mockReturnValue({
        systemd_available: true,
        services: [{ name: "nginx.service", unit: "nginx.service", enabled: true }],
      });

      const response = await request(server).get("/services");

      expect(response.status).toBe(200);
      expect(response.body.systemd_available).toBe(true);
      expect(response.body.services[0].name).toBe("nginx.service");
    });

    it("reports a host without systemd as unsupported", async () => {
      mockSystemdService.listServices.mockImplementation(() => {
        throw new SystemdServiceError("systemd is not available on this host", 501);
      });

      const response = await request(server).get("/services");

      expect(response.status).toBe(501);
      expect(response.body.error).toMatch(/systemd is not available/);
    });

    it("returns 500 when listing fails unexpectedly", async () => {
      mockSystemdService.listServices.mockImplementation(() => {
        throw new Error("systemctl list failed");
      });

      const response = await request(server).get("/services");

      expect(response.status).toBe(500);
      expect(response.body.error).toMatch(/systemctl list failed/);
    });
  });

  describe("POST /services/:unit/actions", () => {
    it("performs a valid action and returns the operation result", async () => {
      mockSystemdService.performAction.mockReturnValue({
        unit: "nginx.service",
        action: "restart",
        success: true,
        exit_code: 0,
        output: "",
        error: "",
      });

      const response = await request(server).post("/services/nginx.service/actions").send({ action: "restart" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockSystemdService.performAction).toHaveBeenCalledWith("nginx.service", "restart");
    });

    it("rejects an action outside the allowlist at validation time", async () => {
      const response = await request(server).post("/services/nginx.service/actions").send({ action: "mask" });

      expect(response.status).toBe(400);
      expect(mockSystemdService.performAction).not.toHaveBeenCalled();
    });

    it("maps an invalid unit to 400", async () => {
      mockSystemdService.performAction.mockImplementation(() => {
        throw new SystemdServiceError("Invalid unit name: bad", 400);
      });

      const response = await request(server).post("/services/bad/actions").send({ action: "start" });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Invalid unit name/);
    });

    it("maps a missing unit to 404", async () => {
      mockSystemdService.performAction.mockImplementation(() => {
        throw new SystemdServiceError("Unit not found: nginx.service", 404);
      });

      const response = await request(server).post("/services/nginx.service/actions").send({ action: "start" });

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/Unit not found/);
    });

    it("maps a host without systemd to 503", async () => {
      mockSystemdService.performAction.mockImplementation(() => {
        throw new SystemdServiceError("systemd is not available on this host", 503);
      });

      const response = await request(server).post("/services/nginx.service/actions").send({ action: "stop" });

      expect(response.status).toBe(503);
    });
  });

  describe("GET /services/:unit/journal", () => {
    it("passes validated lines and since through", async () => {
      mockSystemdService.getJournal.mockReturnValue({
        unit: "nginx.service",
        lines: ["log line"],
        since: "2h",
        output: "log line",
        truncated: false,
      });

      const response = await request(server).get("/services/nginx.service/journal?lines=50&since=2h");

      expect(response.status).toBe(200);
      expect(response.body.output).toBe("log line");
      expect(response.body.lines).toEqual(["log line"]);
      expect(mockSystemdService.getJournal).toHaveBeenCalledWith("nginx.service", 50, "2h");
    });

    it("applies the default line count and since window when omitted", async () => {
      mockSystemdService.getJournal.mockReturnValue({ unit: "nginx.service", lines: 100, since: "1h", output: "", truncated: false });

      const response = await request(server).get("/services/nginx.service/journal");

      expect(response.status).toBe(200);
      expect(mockSystemdService.getJournal).toHaveBeenCalledWith("nginx.service", 100, "1h");
    });

    it.each(["0", "5000", "abc", "1.5"])("rejects an out-of-bounds line count %j at validation time", async lines => {
      const response = await request(server).get(`/services/nginx.service/journal?lines=${lines}`);

      expect(response.status).toBe(400);
      expect(mockSystemdService.getJournal).not.toHaveBeenCalled();
    });

    it.each(["-1h", "1h; rm -rf /", "now --foo", "nonsense"])("rejects an invalid since %j at validation time", async since => {
      const response = await request(server).get(
        `/services/nginx.service/journal?since=${encodeURIComponent(since)}`,
      );

      expect(response.status).toBe(400);
      expect(mockSystemdService.getJournal).not.toHaveBeenCalled();
    });

    it("maps an invalid unit to 400", async () => {
      mockSystemdService.getJournal.mockImplementation(() => {
        throw new SystemdServiceError("Invalid unit name: bad", 400);
      });

      const response = await request(server).get("/services/bad/journal");

      expect(response.status).toBe(400);
    });

    it("maps a missing unit to 404", async () => {
      mockSystemdService.getJournal.mockImplementation(() => {
        throw new SystemdServiceError("Unit not found: nginx.service", 404);
      });

      const response = await request(server).get("/services/nginx.service/journal");

      expect(response.status).toBe(404);
    });
  });
});
