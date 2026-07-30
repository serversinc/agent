import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import config from "../config";

export type CheckKey = "root_ssh_login" | "auto_updates" | "firewall" | "fail2ban" | "time_sync";
export type CheckStatus = "good" | "bad" | "unknown";

export interface StateCheckResult {
  check_key: CheckKey;
  status: CheckStatus;
  detail?: Record<string, unknown> | null;
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function readSshdConfig(): string {
  let content = "";
  if (existsSync("/etc/ssh/sshd_config")) {
    content += readFileSync("/etc/ssh/sshd_config", "utf8") + "\n";
  }
  try {
    const includeDir = "/etc/ssh/sshd_config.d";
    if (existsSync(includeDir)) {
      const files = run(`ls ${includeDir} 2>/dev/null`).split("\n").filter(Boolean);
      for (const file of files) {
        content += readFileSync(`${includeDir}/${file}`, "utf8") + "\n";
      }
    }
  } catch {
    // best effort — missing include dir is not an error
  }
  return content;
}

function checkRootSshLogin(): StateCheckResult {
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

function checkAutoUpdates(): StateCheckResult {
  try {
    const hasUnattendedUpgrades = existsSync("/usr/bin/unattended-upgrade") || existsSync("/etc/apt/apt.conf.d/20auto-upgrades");
    if (hasUnattendedUpgrades) {
      const conf = existsSync("/etc/apt/apt.conf.d/20auto-upgrades")
        ? readFileSync("/etc/apt/apt.conf.d/20auto-upgrades", "utf8")
        : "";
      const enabled = /Unattended-Upgrade\s*"1"/.test(conf);
      return {
        check_key: "auto_updates",
        status: enabled ? "good" : "bad",
        detail: { backend: "unattended-upgrades", enabled },
      };
    }

    const hasDnfAutomatic = existsSync("/etc/dnf/automatic.conf");
    if (hasDnfAutomatic) {
      const active = run("systemctl is-active dnf-automatic.timer 2>/dev/null || true") === "active";
      return { check_key: "auto_updates", status: active ? "good" : "bad", detail: { backend: "dnf-automatic", active } };
    }

    return { check_key: "auto_updates", status: "bad", detail: { backend: null } };
  } catch {
    return { check_key: "auto_updates", status: "unknown", detail: null };
  }
}

function checkFirewall(): StateCheckResult {
  try {
    if (existsSync("/usr/sbin/ufw") || existsSync("/usr/bin/ufw")) {
      const output = run("ufw status 2>/dev/null || true");
      const active = /^Status:\s*active/im.test(output);
      return { check_key: "firewall", status: active ? "good" : "bad", detail: { backend: "ufw", active } };
    }

    const firewalldActive = run("systemctl is-active firewalld 2>/dev/null || true") === "active";
    if (firewalldActive) {
      return { check_key: "firewall", status: "good", detail: { backend: "firewalld", active: true } };
    }
    if (existsSync("/usr/sbin/firewalld") || existsSync("/usr/bin/firewall-cmd")) {
      return { check_key: "firewall", status: "bad", detail: { backend: "firewalld", active: false } };
    }

    return { check_key: "firewall", status: "unknown", detail: { backend: null } };
  } catch {
    return { check_key: "firewall", status: "unknown", detail: null };
  }
}

function checkFail2ban(): StateCheckResult {
  try {
    const installed = existsSync("/usr/bin/fail2ban-client") || existsSync("/usr/sbin/fail2ban-client");
    if (!installed) {
      return { check_key: "fail2ban", status: "bad", detail: { installed: false } };
    }
    const active = run("systemctl is-active fail2ban 2>/dev/null || true") === "active";
    return { check_key: "fail2ban", status: active ? "good" : "bad", detail: { installed: true, active } };
  } catch {
    return { check_key: "fail2ban", status: "unknown", detail: null };
  }
}

function checkTimeSync(): StateCheckResult {
  try {
    const synced = run("timedatectl show -p NTPSynchronized --value 2>/dev/null || true");
    if (synced === "yes" || synced === "no") {
      return { check_key: "time_sync", status: synced === "yes" ? "good" : "bad", detail: { synchronized: synced === "yes" } };
    }
    return { check_key: "time_sync", status: "unknown", detail: null };
  } catch {
    return { check_key: "time_sync", status: "unknown", detail: null };
  }
}

export class StateCheckService {
  private readonly name = "StateCheck";
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) {
      return;
    }

    info(this.name, "Starting state checks", { intervalMs: config.STATE_CHECK_INTERVAL_MS });

    this.runAndSend();

    this.intervalId = setInterval(() => {
      this.runAndSend();
    }, config.STATE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      info(this.name, "State checks stopped");
    }
  }

  private runAndSend(): void {
    try {
      const checks = this.runChecks();
      httpService.postSafe({ type: "state_check", checks }).then(success => {
        if (!success) {
          warn(this.name, "Failed to send state checks");
        }
      });
    } catch (err) {
      warn(this.name, "Failed to run state checks", { error: (err as Error).message });
    }
  }

  private runChecks(): StateCheckResult[] {
    return [
      checkRootSshLogin(),
      checkAutoUpdates(),
      checkFirewall(),
      checkFail2ban(),
      checkTimeSync(),
    ];
  }
}

export const stateCheckService = new StateCheckService();
