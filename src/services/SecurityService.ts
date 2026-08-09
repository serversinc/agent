import { runHost, hostFileExists, readHostFile, writeHostFile } from "./HostShell";
import {
  checkRootSshLogin,
  checkFirewall,
  checkFail2ban,
  checkAutoUpdates,
  StateCheckResult,
} from "./SecurityChecks";

const SSHD_MAIN_CONFIG = "/etc/ssh/sshd_config";
const SSHD_INCLUDE_DIR = "/etc/ssh/sshd_config.d";
const AUTO_UPDATES_CONFIG = "/etc/apt/apt.conf.d/20auto-upgrades";

export class SecurityServiceError extends Error {}

function sshdConfigFiles(): string[] {
  const files: string[] = [];
  if (hostFileExists(SSHD_MAIN_CONFIG)) {
    files.push(SSHD_MAIN_CONFIG);
  }
  try {
    const names = runHost(`sh -c 'ls ${SSHD_INCLUDE_DIR} 2>/dev/null || true'`).split("\n").filter(Boolean);
    for (const name of names) {
      files.push(`${SSHD_INCLUDE_DIR}/${name}`);
    }
  } catch {
    // best effort — missing include dir is not an error
  }
  return files;
}

export class SecurityService {
  setRootSshLogin(enabled: boolean): StateCheckResult {
    const value = enabled ? "yes" : "no";
    const directive = `PermitRootLogin ${value}`;
    const files = sshdConfigFiles();

    let targetFile: string | null = null;
    let targetLineIndex = -1;
    let targetLines: string[] = [];

    for (const file of files) {
      const lines = readHostFile(file).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*PermitRootLogin\s+\S+/i.test(lines[i])) {
          targetFile = file;
          targetLineIndex = i;
          targetLines = lines;
        }
      }
    }

    const writeFile = targetFile ?? files[0] ?? SSHD_MAIN_CONFIG;
    const originalContent = hostFileExists(writeFile) ? readHostFile(writeFile) : "";

    if (targetFile && targetLineIndex >= 0) {
      targetLines[targetLineIndex] = directive;
      writeHostFile(writeFile, targetLines.join("\n"));
    } else {
      const separator = originalContent.length > 0 && !originalContent.endsWith("\n") ? "\n" : "";
      writeHostFile(writeFile, `${originalContent}${separator}${directive}\n`);
    }

    try {
      runHost("sshd -t");
    } catch (err) {
      // Roll back — an invalid config must never be left on disk, even unreloaded.
      writeHostFile(writeFile, originalContent);
      throw new SecurityServiceError(`sshd config validation failed, change rolled back: ${(err as Error).message}`);
    }

    try {
      runHost("sh -c 'systemctl reload sshd 2>/dev/null || systemctl reload ssh'");
    } catch (err) {
      throw new SecurityServiceError(`Failed to reload sshd: ${(err as Error).message}`);
    }

    return checkRootSshLogin();
  }

  setFirewall(enabled: boolean): StateCheckResult {
    if (!hostFileExists("/usr/sbin/ufw") && !hostFileExists("/usr/bin/ufw")) {
      throw new SecurityServiceError("ufw is not installed on this server");
    }

    try {
      if (enabled) {
        runHost("ufw allow OpenSSH");
        runHost("ufw --force enable");
      } else {
        runHost("ufw disable");
      }
    } catch (err) {
      throw new SecurityServiceError(`Failed to ${enabled ? "enable" : "disable"} firewall: ${(err as Error).message}`);
    }

    return checkFirewall();
  }

  addFirewallPort(port: number, protocol: "tcp" | "udp"): StateCheckResult {
    try {
      runHost(`ufw allow ${port}/${protocol}`);
    } catch (err) {
      throw new SecurityServiceError(`Failed to allow port ${port}/${protocol}: ${(err as Error).message}`);
    }

    return checkFirewall();
  }

  removeFirewallPort(port: number, protocol: "tcp" | "udp"): StateCheckResult {
    try {
      runHost(`ufw delete allow ${port}/${protocol}`);
    } catch (err) {
      throw new SecurityServiceError(`Failed to remove port ${port}/${protocol}: ${(err as Error).message}`);
    }

    return checkFirewall();
  }

  listFirewallPorts(): Array<{ port: number; protocol: "tcp" | "udp" }> {
    let output: string;
    try {
      // Plain "ufw status" only shows the app-profile *name* for app-based
      // rules (e.g. just "OpenSSH", no port at all) — "verbose" is the only
      // mode that also prints the underlying port/protocol.
      output = runHost("ufw status verbose");
    } catch (err) {
      throw new SecurityServiceError(`Failed to read firewall status: ${(err as Error).message}`);
    }

    const seen = new Set<string>();
    const ports: Array<{ port: number; protocol: "tcp" | "udp" }> = [];

    for (const line of output.split("\n")) {
      // ufw annotates app-profile rules with a "(ProfileName)" suffix on the
      // port/protocol column (e.g. "22/tcp (OpenSSH)  ALLOW IN  Anywhere") —
      // tolerate that between the protocol and the action.
      const match = line.match(/^([\d,]+)(?:\/(tcp|udp))?(?:\s*\([^)]*\))?\s+ALLOW\b/);
      if (!match) continue;

      const protocol = (match[2] as "tcp" | "udp") || "tcp";
      for (const portStr of match[1].split(",")) {
        const port = parseInt(portStr, 10);
        if (!Number.isFinite(port)) continue;

        const key = `${port}/${protocol}`;
        if (!seen.has(key)) {
          seen.add(key);
          ports.push({ port, protocol });
        }
      }
    }

    return ports;
  }

  setFail2ban(enabled: boolean): StateCheckResult {
    const installed = hostFileExists("/usr/bin/fail2ban-client") || hostFileExists("/usr/sbin/fail2ban-client");
    if (!installed) {
      throw new SecurityServiceError("fail2ban is not installed on this server");
    }

    try {
      runHost(`systemctl ${enabled ? "enable" : "disable"} --now fail2ban`);
    } catch (err) {
      throw new SecurityServiceError(`Failed to ${enabled ? "enable" : "disable"} fail2ban: ${(err as Error).message}`);
    }

    return checkFail2ban();
  }

  setAutoUpdates(enabled: boolean): StateCheckResult {
    const value = enabled ? "1" : "0";
    const content = [
      `APT::Periodic::Update-Package-Lists "${value}";`,
      `APT::Periodic::Unattended-Upgrade "${value}";`,
      "",
    ].join("\n");

    try {
      writeHostFile(AUTO_UPDATES_CONFIG, content);
    } catch (err) {
      throw new SecurityServiceError(`Failed to write auto-updates config: ${(err as Error).message}`);
    }

    return checkAutoUpdates();
  }
}

export const securityService = new SecurityService();
