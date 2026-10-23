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
const mockListContainers = vi.fn();

const AFTER_RULES = "/etc/ufw/after.rules";
const AFTER6_RULES = "/etc/ufw/after6.rules";
const MIGRATION_STATE = "/etc/ufw/agent-docker-user.migrated";
const ORIGINAL_RULES = [
  "*filter",
  ":ufw-user-input - [0:0]",
  "-A ufw-user-input -p tcp --dport 22 -j ACCEPT",
  "COMMIT",
  "",
].join("\n");

type FileMap = Record<string, string | null>;

function mockHostFiles(files: FileMap) {
  const present = new Map(Object.entries(files).filter(([, content]) => content !== null));
  mockHostFileExists.mockImplementation((path: string) => present.has(path));
  mockReadHostFile.mockImplementation((path: string) => present.get(path) ?? "");
  mockWriteHostFile.mockImplementation((path: string, content: string) => {
    present.set(path, content);
  });
  return present;
}

interface ActiveUfwOptions {
  allowed?: string;
  ipv4?: string;
  ipv6?: string;
  reloadError?: string;
}

function mockActiveUfw(options: ActiveUfwOptions = {}) {
  const allowed = options.allowed ?? "";
  const ipv4 = options.ipv4 ?? "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100";
  const ipv6 = options.ipv6 ?? "";

  mockRunHost.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "ufw status":
        return "Status: active";
      case "ufw status verbose":
        return ["Status: active", "", "To Action From", "-- ------ ----", allowed].join("\n");
      case "ip -o route show default":
        return ipv4;
      case "ip -6 -o route show default":
        return ipv6;
      case "ufw reload":
        if (options.reloadError) throw new Error(options.reloadError);
        return "";
      default:
        return "";
    }
  });
}

describe("SecurityService", () => {
  let service: SecurityService;

  beforeEach(() => {
    vi.resetAllMocks();
    mockListContainers.mockResolvedValue([]);
    service = new SecurityService({ listContainers: mockListContainers } as any);
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
    it("throws when ufw is not installed", async () => {
      mockHostFileExists.mockReturnValue(false);

      await expect(service.setFirewall(true)).rejects.toThrow(/ufw is not installed/);
    });

    it("allows OpenSSH before enabling", async () => {
      mockHostFiles({ "/usr/sbin/ufw": "" });
      mockRunHost.mockReturnValue("Status: active");

      await service.setFirewall(true);

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

    it("parses ranges and expands a rule without a protocol to tcp and udp", () => {
      mockRunHost.mockReturnValue(
        [
          "Status: active",
          "",
          "To                         Action      From",
          "--                         ------      ----",
          "1000:2000/udp              ALLOW       Anywhere",
          "5000                       ALLOW       Anywhere",
        ].join("\n"),
      );

      const ports = service.listFirewallPorts();

      expect(ports).toEqual([
        { port: "1000:2000", protocol: "udp" },
        { port: 5000, protocol: "tcp" },
        { port: 5000, protocol: "udp" },
      ]);
    });

    it("dedupes source-restricted rules to port and protocol for the endpoint", () => {
      mockRunHost.mockReturnValue(
        [
          "Status: active",
          "",
          "To                         Action      From",
          "--                         ------      ----",
          "9100/tcp                   ALLOW IN    203.0.113.7",
          "9100/tcp (v6)              ALLOW IN    2001:db8::7",
        ].join("\n"),
      );

      const ports = service.listFirewallPorts();

      expect(ports).toEqual([{ port: 9100, protocol: "tcp" }]);
    });
  });

  describe("syncDockerUserChain", () => {
    it("writes the managed block for the default-route interface and every allowed port", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
      });
      mockActiveUfw({
        allowed: [
          "80/tcp                     ALLOW       Anywhere",
          "443/tcp                    ALLOW       Anywhere",
          "1000:2000/udp              ALLOW       Anywhere",
          "5000                       ALLOW       Anywhere",
        ].join("\n"),
      });

      await service.syncDockerUserChain();

      const expectedAfter = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 1000:2000 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 5000 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 5000 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      const expectedAfter6 = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
COMMIT
# END agent DOCKER-USER
`;

      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER_RULES, expectedAfter);
      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER6_RULES, expectedAfter6);
    });

    it("writes one set of RETURN lines and one DROP line per public interface", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
      });
      mockActiveUfw({
        allowed: "80/tcp                     ALLOW       Anywhere",
        ipv4: [
          "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100",
          "default via 10.0.0.2 dev eth1 proto static metric 200",
        ].join("\n"),
      });

      await service.syncDockerUserChain();

      const expectedAfter = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth1 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
-A DOCKER-USER -i eth1 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER_RULES, expectedAfter);
    });

    it("keeps source restrictions in the matching family's block", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
      });
      mockActiveUfw({
        allowed: [
          "9100/tcp                   ALLOW IN    203.0.113.7",
          "9100/tcp (v6)              ALLOW IN    2001:db8::7",
          "80/tcp                     ALLOW IN    Anywhere",
          "80/tcp (v6)                ALLOW IN    Anywhere (v6)",
        ].join("\n"),
        ipv6: "default via fe80::1 dev eth0 proto ra metric 100",
      });

      await service.syncDockerUserChain();

      const expectedAfter = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -s 203.0.113.7 -p tcp -m conntrack --ctorigdstport 9100 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      const expectedAfter6 = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -s 2001:db8::7 -p tcp -m conntrack --ctorigdstport 9100 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER_RULES, expectedAfter);
      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER6_RULES, expectedAfter6);
    });

    it("does not write or reload when both files already hold the expected block", async () => {
      const expectedAfter = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      const expectedAfter6 = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
COMMIT
# END agent DOCKER-USER
`;

      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: expectedAfter,
        [AFTER6_RULES]: expectedAfter6,
        [MIGRATION_STATE]: "2026-01-01T00:00:00.000Z\n",
      });
      mockActiveUfw({ allowed: "80/tcp                     ALLOW IN    Anywhere" });

      await service.syncDockerUserChain();

      expect(mockReadHostFile).toHaveBeenCalledWith(AFTER_RULES);
      expect(mockReadHostFile).toHaveBeenCalledWith(AFTER6_RULES);
      expect(mockWriteHostFile.mock.calls).toEqual([]);
      expect(mockRunHost.mock.calls.map(call => call[0])).toEqual([
        "ufw status",
        "ufw status verbose",
        "ip -o route show default",
        "ip -6 -o route show default",
      ]);
    });

    it("replaces an existing block in place and keeps the rest of the file byte for byte", async () => {
      const prefix = `${ORIGINAL_RULES}\n`;
      const suffix = "# unaffected trailing line\n";
      const original = `${prefix}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -i old0 -j DROP
COMMIT
# END agent DOCKER-USER
${suffix}`;

      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: original,
        [AFTER6_RULES]: original,
      });
      mockActiveUfw({ allowed: "80/tcp                     ALLOW       Anywhere" });

      await service.syncDockerUserChain();

      const expected = `${prefix}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
${suffix}`;

      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER_RULES, expected);
    });

    it("runs ufw reload after writing both rules files", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER\n*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n# END agent DOCKER-USER\n`,
        [AFTER6_RULES]: `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER\n*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n# END agent DOCKER-USER\n`,
      });
      mockActiveUfw({ allowed: "22/tcp                     ALLOW       Anywhere" });

      await service.syncDockerUserChain();

      expect(mockRunHost.mock.calls.map(call => call[0])).toEqual([
        "ufw status",
        "ufw status verbose",
        "ip -o route show default",
        "ip -6 -o route show default",
        "ufw reload",
      ]);
    });

    it("rolls both files back and retries reload when ufw reload fails", async () => {
      const prefix = `${ORIGINAL_RULES}\n`;
      const suffix = "# unaffected trailing line\n";
      const original = `${prefix}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -i old0 -j DROP
COMMIT
# END agent DOCKER-USER
${suffix}`;

      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: original,
        [AFTER6_RULES]: original,
        [MIGRATION_STATE]: "2026-01-01T00:00:00.000Z\n",
      });
      mockActiveUfw({ allowed: "80/tcp                     ALLOW       Anywhere", reloadError: "invalid rules" });

      await expect(service.syncDockerUserChain()).rejects.toThrow(SecurityServiceError);

      expect(mockWriteHostFile).toHaveBeenNthCalledWith(1, AFTER_RULES, expect.any(String));
      expect(mockWriteHostFile).toHaveBeenNthCalledWith(2, AFTER6_RULES, expect.any(String));
      expect(mockWriteHostFile).toHaveBeenNthCalledWith(3, AFTER_RULES, original);
      expect(mockWriteHostFile).toHaveBeenNthCalledWith(4, AFTER6_RULES, original);
      expect(mockRunHost.mock.calls.map(call => call[0]).filter(cmd => cmd === "ufw reload")).toEqual([
        "ufw reload",
        "ufw reload",
      ]);
    });

    it("migrates published container ports once and records completion", async () => {
      const files = mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
      });
      mockActiveUfw({ allowed: "22/tcp                     ALLOW       Anywhere" });
      mockListContainers.mockResolvedValue([
        { state: "running", ports: [{ type: "tcp", ip: "0.0.0.0", private: 6379, public: 6379 }] },
        { state: "running", ports: [{ type: "tcp", ip: "127.0.0.1", private: 3000, public: 3000 }] },
        { state: "running", ports: [{ type: "tcp", ip: "::", private: 8080, public: 8080 }] },
      ]);

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
      try {
        await service.syncDockerUserChain();
      } finally {
        vi.useRealTimers();
      }

      expect(mockRunHost.mock.calls.map(call => call[0]).filter(cmd => cmd.startsWith("ufw allow "))).toEqual([
        "ufw allow 6379/tcp",
        "ufw allow 8080/tcp",
      ]);
      expect(mockWriteHostFile.mock.calls.map(call => call[0])).toEqual([
        MIGRATION_STATE,
        AFTER_RULES,
        AFTER6_RULES,
      ]);
      expect(mockWriteHostFile).toHaveBeenCalledWith(MIGRATION_STATE, "2026-10-23T12:00:00.000Z\n");
      expect(files.get(MIGRATION_STATE)).toBe("2026-10-23T12:00:00.000Z\n");
    });

    it("does not migrate published ports again when the state file already exists", async () => {
      const stateContent = "2026-01-01T00:00:00.000Z\n";
      const files = mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
        [MIGRATION_STATE]: stateContent,
      });
      mockActiveUfw({ allowed: "22/tcp                     ALLOW IN    Anywhere" });
      mockListContainers.mockResolvedValue([
        { state: "running", ports: [{ type: "tcp", ip: "0.0.0.0", private: 7010, public: 7010 }] },
      ]);

      await service.syncDockerUserChain();

      expect(mockRunHost.mock.calls.map(call => call[0])).toEqual([
        "ufw status",
        "ufw status verbose",
        "ip -o route show default",
        "ip -6 -o route show default",
        "ufw reload",
      ]);

      const expectedAfter = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 22 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;

      expect(mockWriteHostFile).toHaveBeenCalledWith(AFTER_RULES, expectedAfter);
      expect(files.get(MIGRATION_STATE)).toBe(stateContent);
    });

    it("removes the block and flushes the Docker chains when ufw is inactive", async () => {
      const withBlock = `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i eth0 -j DROP
COMMIT
# END agent DOCKER-USER
`;
      const stateContent = "2026-01-01T00:00:00.000Z\n";

      const files = mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: withBlock,
        [AFTER6_RULES]: withBlock,
        [MIGRATION_STATE]: stateContent,
      });
      mockRunHost.mockReturnValue("Status: inactive");

      await service.syncDockerUserChain();

      expect(mockWriteHostFile).toHaveBeenNthCalledWith(1, AFTER_RULES, ORIGINAL_RULES);
      expect(mockWriteHostFile).toHaveBeenNthCalledWith(2, AFTER6_RULES, ORIGINAL_RULES);
      expect(mockWriteHostFile.mock.calls.map(call => call[0])).toEqual([AFTER_RULES, AFTER6_RULES]);
      expect(files.get(MIGRATION_STATE)).toBe(stateContent);
      expect(mockRunHost.mock.calls.map(call => call[0])).toEqual([
        "ufw status",
        "iptables -F DOCKER-USER",
        "ip6tables -F DOCKER-USER",
      ]);
    });

    it("leaves both files untouched when Docker uses the nftables firewall backend", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: ORIGINAL_RULES,
        [AFTER6_RULES]: ORIGINAL_RULES,
        "/etc/docker/daemon.json": '{"firewall-backend": "nftables"}',
      });

      await service.syncDockerUserChain();

      expect(mockRunHost.mock.calls).toEqual([]);
      expect(mockWriteHostFile.mock.calls).toEqual([]);
      expect(mockReadHostFile).toHaveBeenCalledWith("/etc/docker/daemon.json");
    });

    it("is called by addFirewallPort before the fresh firewall check", async () => {
      mockHostFiles({
        "/usr/sbin/ufw": "",
        [AFTER_RULES]: `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER\n*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n# END agent DOCKER-USER\n`,
        [AFTER6_RULES]: `${ORIGINAL_RULES}# BEGIN agent DOCKER-USER\n*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n# END agent DOCKER-USER\n`,
      });
      mockActiveUfw({ allowed: "8080/tcp                   ALLOW       Anywhere" });

      await service.addFirewallPort(8080, "tcp");

      expect(mockRunHost.mock.calls.map(call => call[0])).toEqual([
        "ufw allow 8080/tcp",
        "ufw status",
        "ufw status verbose",
        "ip -o route show default",
        "ip -6 -o route show default",
        "ufw reload",
        "sh -c 'ufw status 2>/dev/null || true'",
      ]);
      expect(mockWriteHostFile).toHaveBeenCalledWith(
        AFTER_RULES,
        expect.stringContaining("-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -j RETURN"),
      );
    });
  });
});
