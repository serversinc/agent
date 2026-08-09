import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecurityService, SecurityServiceError } from "../../src/services/SecurityService";
import * as HostShell from "../../src/services/HostShell";

vi.mock("../../src/services/HostShell", () => ({
  runHost: vi.fn(),
  hostFileExists: vi.fn(),
  readHostFile: vi.fn(),
  writeHostFile: vi.fn(),
  hostCommand: vi.fn((cmd: string) => cmd),
}));

const mockRunHost = HostShell.runHost as unknown as ReturnType<typeof vi.fn>;
const mockHostFileExists = HostShell.hostFileExists as unknown as ReturnType<typeof vi.fn>;
const mockReadHostFile = HostShell.readHostFile as unknown as ReturnType<typeof vi.fn>;
const mockWriteHostFile = HostShell.writeHostFile as unknown as ReturnType<typeof vi.fn>;

describe("SecurityService", () => {
  let service: SecurityService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SecurityService();
  });

  describe("setRootSshLogin", () => {
    it("rewrites the last PermitRootLogin line in place and reloads sshd", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/etc/ssh/sshd_config");
      mockReadHostFile.mockReturnValue("Port 22\nPermitRootLogin yes\nX11Forwarding no\n");
      mockRunHost.mockReturnValue("");

      const result = service.setRootSshLogin(false);

      expect(mockWriteHostFile).toHaveBeenCalledWith(
        "/etc/ssh/sshd_config",
        expect.stringContaining("PermitRootLogin no"),
      );
      expect(mockRunHost).toHaveBeenCalledWith("sshd -t");
      expect(result.check_key).toBe("root_ssh_login");
    });

    it("appends the directive when none exists", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/etc/ssh/sshd_config");
      mockReadHostFile.mockReturnValue("Port 22\n");
      mockRunHost.mockReturnValue("");

      service.setRootSshLogin(true);

      expect(mockWriteHostFile).toHaveBeenCalledWith(
        "/etc/ssh/sshd_config",
        expect.stringContaining("PermitRootLogin yes"),
      );
    });

    it("rolls back the write and throws when sshd -t fails", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/etc/ssh/sshd_config");
      const original = "Port 22\nPermitRootLogin yes\n";
      mockReadHostFile.mockReturnValue(original);
      mockRunHost.mockImplementation((cmd: string) => {
        if (cmd === "sshd -t") throw new Error("line 4: Bad configuration option");
        return "";
      });

      expect(() => service.setRootSshLogin(false)).toThrow(SecurityServiceError);

      // First call writes the new directive, second call rolls back to the original content.
      expect(mockWriteHostFile).toHaveBeenNthCalledWith(2, "/etc/ssh/sshd_config", original);
      // Never reaches the reload step.
      expect(mockRunHost).not.toHaveBeenCalledWith(expect.stringContaining("systemctl reload"));
    });
  });

  describe("setFirewall", () => {
    it("throws when ufw is not installed", () => {
      mockHostFileExists.mockReturnValue(false);

      expect(() => service.setFirewall(true)).toThrow(/ufw is not installed/);
    });

    it("allows OpenSSH before enabling", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/usr/sbin/ufw");
      mockRunHost.mockReturnValue("Status: active");

      service.setFirewall(true);

      const calls = mockRunHost.mock.calls.map(c => c[0]);
      expect(calls.indexOf("ufw allow OpenSSH")).toBeLessThan(calls.indexOf("ufw --force enable"));
    });
  });

  describe("setFail2ban", () => {
    it("throws when fail2ban is not installed", () => {
      mockHostFileExists.mockReturnValue(false);

      expect(() => service.setFail2ban(true)).toThrow(/not installed/);
      expect(mockRunHost).not.toHaveBeenCalled();
    });

    it("enables fail2ban when installed", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/usr/bin/fail2ban-client");
      mockRunHost.mockReturnValue("active");

      service.setFail2ban(true);

      expect(mockRunHost).toHaveBeenCalledWith("systemctl enable --now fail2ban");
    });
  });

  describe("setAutoUpdates", () => {
    it("writes the 20auto-upgrades config", () => {
      mockHostFileExists.mockReturnValue(true);
      mockReadHostFile.mockReturnValue('APT::Periodic::Unattended-Upgrade "1";\n');

      service.setAutoUpdates(true);

      expect(mockWriteHostFile).toHaveBeenCalledWith(
        "/etc/apt/apt.conf.d/20auto-upgrades",
        expect.stringContaining('APT::Periodic::Unattended-Upgrade "1"'),
      );
    });
  });

  describe("listFirewallPorts", () => {
    it("parses ufw status output and expands comma-separated ports", () => {
      mockRunHost.mockReturnValue(
        [
          "Status: active",
          "",
          "To                         Action      From",
          "--                         ------      ----",
          "22/tcp                     ALLOW       Anywhere",
          "80,443/tcp                 ALLOW       Anywhere",
          "22/tcp (v6)                ALLOW       Anywhere (v6)",
        ].join("\n"),
      );

      const ports = service.listFirewallPorts();

      expect(ports).toEqual([
        { port: 22, protocol: "tcp" },
        { port: 80, protocol: "tcp" },
        { port: 443, protocol: "tcp" },
      ]);
    });

    it("parses app-profile rules like ufw allow OpenSSH produces", () => {
      // Real `ufw status verbose` output from a box where setFirewall() had
      // run `ufw allow OpenSSH` — app-profile rules get a "(ProfileName)"
      // suffix on the port/protocol column instead of a bare port line.
      mockRunHost.mockReturnValue(
        [
          "Status: active",
          "",
          "To                         Action      From",
          "--                         ------      ----",
          "22/tcp (OpenSSH)           ALLOW IN    Anywhere",
          "22/tcp (OpenSSH (v6))      ALLOW IN    Anywhere (v6)",
        ].join("\n"),
      );

      const ports = service.listFirewallPorts();

      expect(ports).toEqual([{ port: 22, protocol: "tcp" }]);
    });
  });
});
