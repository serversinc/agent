import { runHost, hostFileExists, readHostFile } from "./HostShell";

export type CheckKey = "root_ssh_login" | "auto_updates" | "firewall" | "fail2ban" | "time_sync";
export type CheckStatus = "good" | "bad" | "unknown";

export interface StateCheckResult {
  check_key: CheckKey;
  status: CheckStatus;
  detail?: Record<string, unknown> | null;
}

export function readSshdConfig(): string {
  let content = "";
  if (hostFileExists("/etc/ssh/sshd_config")) {
    content += readHostFile("/etc/ssh/sshd_config") + "\n";
  }
  try {
    const includeDir = "/etc/ssh/sshd_config.d";
    const files = runHost(`sh -c 'ls ${includeDir} 2>/dev/null || true'`).split("\n").filter(Boolean);
    for (const file of files) {
      content += readHostFile(`${includeDir}/${file}`) + "\n";
    }
  } catch {
    // best effort — missing include dir is not an error
  }
  return content;
}

export function checkRootSshLogin(): StateCheckResult {
  try {
    const sshdConfig = readSshdConfig();
    const matches = [...sshdConfig.matchAll(/^\s*PermitRootLogin\s+(\S+)/gim)];
    if (matches.length === 0) {
      return { check_key: "root_ssh_login", status: "unknown", detail: null };
    }
    const value = matches[matches.length - 1][1].toLowerCase();
    const status: CheckStatus = value === "yes" ? "bad" : "good";
    return { check_key: "root_ssh_login", status, detail: { permit_root_login: value } };
  } catch {
    return { check_key: "root_ssh_login", status: "unknown", detail: null };
  }
}

export function checkAutoUpdates(): StateCheckResult {
  try {
    const hasUnattendedUpgrades = hostFileExists("/usr/bin/unattended-upgrade") || hostFileExists("/etc/apt/apt.conf.d/20auto-upgrades");
    if (hasUnattendedUpgrades) {
      const conf = hostFileExists("/etc/apt/apt.conf.d/20auto-upgrades") ? readHostFile("/etc/apt/apt.conf.d/20auto-upgrades") : "";
      const enabled = /Unattended-Upgrade\s*"1"/.test(conf);
      return {
        check_key: "auto_updates",
        status: enabled ? "good" : "bad",
        detail: { backend: "unattended-upgrades", enabled },
      };
    }

    const hasDnfAutomatic = hostFileExists("/etc/dnf/automatic.conf");
    if (hasDnfAutomatic) {
      const active = runHost("sh -c 'systemctl is-active dnf-automatic.timer 2>/dev/null || true'") === "active";
      return { check_key: "auto_updates", status: active ? "good" : "bad", detail: { backend: "dnf-automatic", active } };
    }

    return { check_key: "auto_updates", status: "bad", detail: { backend: null } };
  } catch {
    return { check_key: "auto_updates", status: "unknown", detail: null };
  }
}

export function checkFirewall(): StateCheckResult {
  try {
    if (hostFileExists("/usr/sbin/ufw") || hostFileExists("/usr/bin/ufw")) {
      const output = runHost("sh -c 'ufw status 2>/dev/null || true'");
      const active = /^Status:\s*active/im.test(output);
      return { check_key: "firewall", status: active ? "good" : "bad", detail: { backend: "ufw", active } };
    }

    const firewalldActive = runHost("sh -c 'systemctl is-active firewalld 2>/dev/null || true'") === "active";
    if (firewalldActive) {
      return { check_key: "firewall", status: "good", detail: { backend: "firewalld", active: true } };
    }
    if (hostFileExists("/usr/sbin/firewalld") || hostFileExists("/usr/bin/firewall-cmd")) {
      return { check_key: "firewall", status: "bad", detail: { backend: "firewalld", active: false } };
    }

    return { check_key: "firewall", status: "unknown", detail: { backend: null } };
  } catch {
    return { check_key: "firewall", status: "unknown", detail: null };
  }
}

export function checkFail2ban(): StateCheckResult {
  try {
    const installed = hostFileExists("/usr/bin/fail2ban-client") || hostFileExists("/usr/sbin/fail2ban-client");
    if (!installed) {
      return { check_key: "fail2ban", status: "bad", detail: { installed: false } };
    }
    const active = runHost("sh -c 'systemctl is-active fail2ban 2>/dev/null || true'") === "active";
    return { check_key: "fail2ban", status: active ? "good" : "bad", detail: { installed: true, active } };
  } catch {
    return { check_key: "fail2ban", status: "unknown", detail: null };
  }
}

export function checkTimeSync(): StateCheckResult {
  try {
    const synced = runHost("sh -c 'timedatectl show -p NTPSynchronized --value 2>/dev/null || true'");
    if (synced === "yes" || synced === "no") {
      return { check_key: "time_sync", status: synced === "yes" ? "good" : "bad", detail: { synchronized: synced === "yes" } };
    }
    return { check_key: "time_sync", status: "unknown", detail: null };
  } catch {
    return { check_key: "time_sync", status: "unknown", detail: null };
  }
}

export function runSecurityChecks(): StateCheckResult[] {
  return [
    checkRootSshLogin(),
    checkAutoUpdates(),
    checkFirewall(),
    checkFail2ban(),
    checkTimeSync(),
  ];
}
