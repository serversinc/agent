import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createSecurityHandlers } from "../../src/controllers/security";
import { SecurityServiceError } from "../../src/services/SecurityService";
import { makeApp } from "../helpers/makeApp";
import { runSecurityChecks } from "../../src/services/SecurityChecks";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/services/SecurityChecks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/SecurityChecks")>("../../src/services/SecurityChecks");
  return { ...actual, runSecurityChecks: vi.fn() };
});

describe("Security Handlers", () => {
  let server: import("http").Server;
  let mockSecurityService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockSecurityService = {
      setRootSshLogin: vi.fn(),
      setFirewall: vi.fn(),
      addFirewallPort: vi.fn(),
      removeFirewallPort: vi.fn(),
      listFirewallPorts: vi.fn(),
      setFail2ban: vi.fn(),
      setAutoUpdates: vi.fn(),
    };

    const handlers = createSecurityHandlers(mockSecurityService);

    const s = await makeApp(
      app => {
        app.get("/security", handlers.getStatus);
        app.put("/security/root-login", handlers.updateRootSshLogin);
        app.put("/security/firewall", handlers.updateFirewall);
        app.get("/security/firewall/ports", handlers.listFirewallPorts);
        app.post("/security/firewall/ports", handlers.addFirewallPort);
        app.delete("/security/firewall/ports/:port", handlers.removeFirewallPort);
        app.put("/security/fail2ban", handlers.updateFail2ban);
        app.put("/security/auto-updates", handlers.updateAutoUpdates);
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

  describe("GET /security", () => {
    it("returns the current checks", async () => {
      (runSecurityChecks as any).mockReturnValue([{ check_key: "firewall", status: "good", detail: {} }]);

      const response = await request(server).get("/security");

      expect(response.status).toBe(200);
      expect(response.body.checks).toHaveLength(1);
    });
  });

  describe("PUT /security/root-login", () => {
    it("applies the change and returns the fresh check", async () => {
      mockSecurityService.setRootSshLogin.mockReturnValue({
        check_key: "root_ssh_login",
        status: "good",
        detail: { permit_root_login: "no" },
      });

      const response = await request(server).put("/security/root-login").send({ enabled: false });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("good");
      expect(mockSecurityService.setRootSshLogin).toHaveBeenCalledWith(false);
    });

    it("returns 400 when the service throws a SecurityServiceError", async () => {
      mockSecurityService.setRootSshLogin.mockImplementation(() => {
        throw new SecurityServiceError("sshd config validation failed, not reloading: bad config");
      });

      const response = await request(server).put("/security/root-login").send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/sshd config validation failed/);
    });
  });

  describe("PUT /security/firewall", () => {
    it("enables the firewall", async () => {
      mockSecurityService.setFirewall.mockReturnValue({ check_key: "firewall", status: "good", detail: { backend: "ufw", active: true } });

      const response = await request(server).put("/security/firewall").send({ enabled: true });

      expect(response.status).toBe(200);
      expect(mockSecurityService.setFirewall).toHaveBeenCalledWith(true);
    });
  });

  describe("firewall ports", () => {
    it("lists ports", async () => {
      mockSecurityService.listFirewallPorts.mockReturnValue([{ port: 22, protocol: "tcp" }]);

      const response = await request(server).get("/security/firewall/ports");

      expect(response.status).toBe(200);
      expect(response.body.ports).toEqual([{ port: 22, protocol: "tcp" }]);
    });

    it("adds a port", async () => {
      mockSecurityService.addFirewallPort.mockReturnValue({ check_key: "firewall", status: "good", detail: {} });

      const response = await request(server).post("/security/firewall/ports").send({ port: 8080, protocol: "tcp" });

      expect(response.status).toBe(200);
      expect(mockSecurityService.addFirewallPort).toHaveBeenCalledWith(8080, "tcp");
    });

    it("removes a port", async () => {
      mockSecurityService.removeFirewallPort.mockReturnValue({ check_key: "firewall", status: "good", detail: {} });

      const response = await request(server).delete("/security/firewall/ports/8080?protocol=udp");

      expect(response.status).toBe(200);
      expect(mockSecurityService.removeFirewallPort).toHaveBeenCalledWith(8080, "udp");
    });

    it("rejects an invalid port", async () => {
      const response = await request(server).delete("/security/firewall/ports/notaport");

      expect(response.status).toBe(400);
      expect(mockSecurityService.removeFirewallPort).not.toHaveBeenCalled();
    });
  });

  describe("PUT /security/fail2ban", () => {
    it("returns 400 when fail2ban is not installed", async () => {
      mockSecurityService.setFail2ban.mockImplementation(() => {
        throw new SecurityServiceError("fail2ban is not installed on this server");
      });

      const response = await request(server).put("/security/fail2ban").send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not installed/);
    });
  });

  describe("PUT /security/auto-updates", () => {
    it("applies the change", async () => {
      mockSecurityService.setAutoUpdates.mockReturnValue({ check_key: "auto_updates", status: "good", detail: {} });

      const response = await request(server).put("/security/auto-updates").send({ enabled: true });

      expect(response.status).toBe(200);
      expect(mockSecurityService.setAutoUpdates).toHaveBeenCalledWith(true);
    });
  });
});
