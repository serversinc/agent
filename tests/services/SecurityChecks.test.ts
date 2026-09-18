import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkOsUpdates, parseAptUpgrades, runSecurityChecks } from "../../src/services/SecurityChecks";
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

// Snippets of real `apt-get -s dist-upgrade` output. The `Inst` lines carry
// the origin pocket in parentheses; new installs have no `[oldVersion]`.
const UBUNTU_UPGRADE_OUTPUT = [
  "Reading package lists...",
  "Building dependency tree...",
  "Reading state information...",
  "Calculating upgrade...",
  "The following packages will be upgraded:",
  "  libc6 libssl3 openssl",
  "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
  "Inst libc6 [2.35-0ubuntu3.1] (2.35-0ubuntu3.4 Ubuntu:22.04/jammy-updates [amd64])",
  "Inst libssl3 [3.0.2-0ubuntu1.7] (3.0.2-0ubuntu1.10 Ubuntu:22.04/jammy-security [amd64])",
  "Inst openssl [3.0.2-0ubuntu1.7] (3.0.2-0ubuntu1.10 Ubuntu:22.04/jammy-security [amd64])",
  "Conf libc6 (2.35-0ubuntu3.4 Ubuntu:22.04/jammy-updates [amd64])",
  "Conf libssl3 (3.0.2-0ubuntu1.10 Ubuntu:22.04/jammy-security [amd64])",
  "Conf openssl (3.0.2-0ubuntu1.10 Ubuntu:22.04/jammy-security [amd64])",
].join("\n");

const DEBIAN_UPGRADE_OUTPUT = [
  "Inst curl [7.88.1-10+deb12u4] (7.88.1-10+deb12u5 Debian-Security:stable-security [amd64])",
  "Inst tzdata [2024a-0+deb12u1] (2024b-0+deb12u1 Debian:stable-updates [all])",
].join("\n");

describe("SecurityChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseAptUpgrades", () => {
    it("counts upgrades and how many come from a security pocket", () => {
      expect(parseAptUpgrades(UBUNTU_UPGRADE_OUTPUT)).toEqual({ total: 3, security: 2 });
    });

    it("recognises the Debian security origin", () => {
      expect(parseAptUpgrades(DEBIAN_UPGRADE_OUTPUT)).toEqual({ total: 2, security: 1 });
    });

    it("ignores newly installed packages that have no old version", () => {
      const output = [
        "Inst libc6 [2.35-0ubuntu3.1] (2.35-0ubuntu3.4 Ubuntu:22.04/jammy-updates [amd64])",
        "Inst newpkg (1.0 Debian:stable/non-free [amd64])",
      ].join("\n");

      expect(parseAptUpgrades(output)).toEqual({ total: 1, security: 0 });
    });

    it("returns zero counts when nothing is upgraded", () => {
      const output = [
        "Calculating upgrade...",
        "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
      ].join("\n");

      expect(parseAptUpgrades(output)).toEqual({ total: 0, security: 0 });
    });
  });

  describe("checkOsUpdates", () => {
    it("reports total and security counts from apt", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/usr/bin/apt-get");
      mockRunHost.mockReturnValue(UBUNTU_UPGRADE_OUTPUT);

      const result = checkOsUpdates();

      expect(result).toEqual({
        check_key: "os_updates",
        status: "bad",
        detail: { total: 3, security: 2 },
      });
      expect(mockRunHost).toHaveBeenCalledWith("sh -c 'apt-get -s -q dist-upgrade 2>/dev/null || true'");
    });

    it("reports good when the system is fully patched", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/usr/bin/apt-get");
      mockRunHost.mockReturnValue("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.");

      expect(checkOsUpdates()).toEqual({
        check_key: "os_updates",
        status: "good",
        detail: { total: 0, security: 0 },
      });
    });

    it("reports unknown when apt is not installed", () => {
      mockHostFileExists.mockReturnValue(false);

      expect(checkOsUpdates()).toEqual({ check_key: "os_updates", status: "unknown", detail: null });
      expect(mockRunHost).not.toHaveBeenCalled();
    });

    it("reports unknown when the apt command fails", () => {
      mockHostFileExists.mockImplementation((p: string) => p === "/usr/bin/apt-get");
      mockRunHost.mockImplementation(() => {
        throw new Error("apt-get: command not found");
      });

      expect(checkOsUpdates()).toEqual({ check_key: "os_updates", status: "unknown", detail: null });
    });
  });

  describe("runSecurityChecks", () => {
    it("includes the os_updates check alongside the hardening checks", () => {
      mockHostFileExists.mockReturnValue(false);
      mockRunHost.mockReturnValue("");

      const keys = runSecurityChecks().map(check => check.check_key);

      expect(keys).toEqual(["root_ssh_login", "auto_updates", "firewall", "fail2ban", "time_sync", "os_updates"]);
    });
  });
});
