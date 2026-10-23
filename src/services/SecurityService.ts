import { runHost, hostFileExists, readHostFile, writeHostFile } from "./HostShell";
import type { DockerService } from "./Docker";
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
const UFW_AFTER_RULES = "/etc/ufw/after.rules";
const UFW_AFTER6_RULES = "/etc/ufw/after6.rules";
const DOCKER_USER_MIGRATED = "/etc/ufw/agent-docker-user.migrated";
const DOCKER_DAEMON_CONFIG = "/etc/docker/daemon.json";
const DOCKER_USER_BEGIN = "# BEGIN agent DOCKER-USER";
const DOCKER_USER_END = "# END agent DOCKER-USER";

export type FirewallProtocol = "tcp" | "udp";

type FirewallAction = "ALLOW" | "DENY" | "REJECT";

export interface FirewallPortRule {
  // ufw prints a range as "1000:2000"; single ports stay numeric so existing
  // callers (and the HTTP response) keep the shape they have always had.
  port: number | string;
  protocol: FirewallProtocol;
}

interface DockerUserRule extends FirewallPortRule {
  action: FirewallAction;
  // Absent for an "Anywhere" rule. Present rules only appear in the file for
  // their own address family.
  source?: string;
}

interface DockerUserRules {
  ipv4: DockerUserRule[];
  ipv6: DockerUserRule[];
}

interface UfwStatusRow {
  ports: FirewallPortRule[];
  from: string;
  action: FirewallAction;
}

export class SecurityServiceError extends Error {}

function expandPorts(portField: string, protocols: FirewallProtocol[]): FirewallPortRule[] {
  const ports: FirewallPortRule[] = [];

  for (const portStr of portField.split(",")) {
    const isRange = portStr.includes(":");
    const numericPort = parseInt(portStr, 10);
    if (!isRange && !Number.isFinite(numericPort)) continue;

    const port: number | string = isRange ? portStr : numericPort;
    for (const protocol of protocols) {
      ports.push({ port, protocol });
    }
  }

  return ports;
}

/**
 * Split a `ufw status verbose` row into its port rules, From column and
 * action. The To column may carry an app-profile name in parentheses (which
 * can itself contain a "(v6)" marker), so the optional group is greedy. ufw
 * prints a rate-limited rule as LIMIT, which for containers behaves like
 * ALLOW.
 */
function parseUfwStatusRow(line: string): UfwStatusRow | null {
  const match = line.match(
    /^(\S+)(?:\s+\(.+\))?\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|FWD|OUT))?\s+(.+?)\s*$/,
  );
  if (!match) return null;

  const to = match[1].match(/^([\d,:]+)(?:\/(tcp|udp))?$/);
  if (!to) return null;

  const protocols: FirewallProtocol[] = to[2] ? [to[2] as FirewallProtocol] : ["tcp", "udp"];
  const ports = expandPorts(to[1], protocols);
  if (ports.length === 0) return null;

  const action: FirewallAction = match[2] === "LIMIT" ? "ALLOW" : (match[2] as FirewallAction);
  return { ports, from: match[3].trim(), action };
}

function isUfwInstalled(): boolean {
  return hostFileExists("/usr/sbin/ufw") || hostFileExists("/usr/bin/ufw");
}

/**
 * ufw is first-match-wins, so the generated chain has to carry rules in the
 * same order ufw lists them, including the ones that deny or reject traffic.
 */
function ruleTarget(rule: DockerUserRule): string {
  if (rule.action === "DENY") return "-j DROP";
  if (rule.action === "REJECT") {
    return rule.protocol === "tcp" ? "-j REJECT --reject-with tcp-reset" : "-j REJECT";
  }
  return "-j RETURN";
}

/**
 * Docker publishes container ports by DNAT-ing them through FORWARD, not
 * INPUT, so ufw rules never see the traffic. after.rules/after6.rules are
 * loaded by ufw itself and can carry a DOCKER-USER chain ahead of Docker's
 * own rules. The block is delimited so it can be replaced in place.
 */
function dockerUserBlock(interfaces: string[], rules: DockerUserRule[]): string {
  const lines = [
    DOCKER_USER_BEGIN,
    "*filter",
    ":DOCKER-USER - [0:0]",
    "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
  ];

  for (const iface of interfaces) {
    for (const rule of rules) {
      const source = rule.source ? ` -s ${rule.source}` : "";
      lines.push(
        `-A DOCKER-USER -i ${iface}${source} -p ${rule.protocol} -m conntrack --ctorigdstport ${rule.port} --ctdir ORIGINAL ${ruleTarget(rule)}`,
      );
    }
  }

  for (const iface of interfaces) {
    lines.push(`-A DOCKER-USER -i ${iface} -j DROP`);
  }

  lines.push("COMMIT", DOCKER_USER_END);
  return lines.join("\n");
}

/** Replace the managed block in place, or append it after the last COMMIT. */
function upsertDockerUserBlock(content: string, block: string): string {
  const begin = content.indexOf(DOCKER_USER_BEGIN);
  if (begin !== -1) {
    const endMarker = content.indexOf(DOCKER_USER_END, begin);
    const end = endMarker === -1 ? content.length : endMarker + DOCKER_USER_END.length;
    return `${content.slice(0, begin)}${block}${content.slice(end)}`;
  }

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${separator}${block}\n`;
}

/** Remove the managed block and the newline that was added with it. */
function stripDockerUserBlock(content: string): string {
  const begin = content.indexOf(DOCKER_USER_BEGIN);
  if (begin === -1) return content;

  const endMarker = content.indexOf(DOCKER_USER_END, begin);
  if (endMarker === -1) return content;

  let end = endMarker + DOCKER_USER_END.length;
  if (content[end] === "\n") end += 1;
  return `${content.slice(0, begin)}${content.slice(end)}`;
}

function ruleKey(rule: FirewallPortRule): string {
  return `${rule.port}/${rule.protocol}`;
}

/** Append unrestricted allow rules that are not already present in a family. */
function withUniqueRules(rules: DockerUserRule[], additions: FirewallPortRule[]): DockerUserRule[] {
  const seen = new Set(rules.map(rule => `${rule.action}|${rule.source ?? ""}|${ruleKey(rule)}`));
  const merged = [...rules];

  for (const addition of additions) {
    const key = `ALLOW||${ruleKey(addition)}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ ...addition, action: "ALLOW" });
    }
  }

  return merged;
}

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
  constructor(private readonly dockerService?: Pick<DockerService, "listContainers">) {}

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

  async setFirewall(enabled: boolean): Promise<StateCheckResult> {
    if (!isUfwInstalled()) {
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

    await this.syncDockerUserChain();
    return checkFirewall();
  }

  async addFirewallPort(port: number, protocol: "tcp" | "udp"): Promise<StateCheckResult> {
    try {
      runHost(`ufw allow ${port}/${protocol}`);
    } catch (err) {
      throw new SecurityServiceError(`Failed to allow port ${port}/${protocol}: ${(err as Error).message}`);
    }

    await this.syncDockerUserChain();
    return checkFirewall();
  }

  async removeFirewallPort(port: number, protocol: "tcp" | "udp"): Promise<StateCheckResult> {
    try {
      runHost(`ufw delete allow ${port}/${protocol}`);
    } catch (err) {
      throw new SecurityServiceError(`Failed to remove port ${port}/${protocol}: ${(err as Error).message}`);
    }

    await this.syncDockerUserChain();
    return checkFirewall();
  }

  listFirewallPorts(): FirewallPortRule[] {
    return this.parseFirewallPorts(this.readFirewallStatus());
  }

  /**
   * Plain "ufw status" only shows the app-profile *name* for app-based rules
   * (e.g. just "OpenSSH", no port at all) — "verbose" is the only mode that
   * also prints the underlying port/protocol and the From column.
   */
  private readFirewallStatus(): string {
    try {
      return runHost("ufw status verbose");
    } catch (err) {
      throw new SecurityServiceError(`Failed to read firewall status: ${(err as Error).message}`);
    }
  }

  private parseFirewallPorts(output: string, actions: FirewallAction[] = ["ALLOW"]): FirewallPortRule[] {
    const seen = new Set<string>();
    const ports: FirewallPortRule[] = [];

    for (const line of output.split("\n")) {
      const row = parseUfwStatusRow(line);
      if (!row || !actions.includes(row.action)) continue;

      for (const rule of row.ports) {
        const key = ruleKey(rule);
        if (!seen.has(key)) {
          seen.add(key);
          ports.push(rule);
        }
      }
    }

    return ports;
  }

  /**
   * The HTTP endpoint only needs port/protocol, but the DOCKER-USER block must
   * also keep ufw's source restriction and action in ufw's own order. ufw
   * prints a dual-stack "Anywhere" rule as two rows; dedupe keeps one rule per
   * family, source and action.
   */
  private parseDockerUserRules(output: string): DockerUserRules {
    const ipv4 = new Map<string, DockerUserRule>();
    const ipv6 = new Map<string, DockerUserRule>();

    for (const line of output.split("\n")) {
      const row = parseUfwStatusRow(line);
      if (!row) continue;

      const targets: Array<{ family: keyof DockerUserRules; source?: string }> = [];
      if (row.from === "Anywhere") {
        targets.push({ family: "ipv4" }, { family: "ipv6" });
      } else if (row.from === "Anywhere (v6)") {
        targets.push({ family: "ipv6" });
      } else if (row.from.includes(":")) {
        targets.push({ family: "ipv6", source: row.from });
      } else {
        targets.push({ family: "ipv4", source: row.from });
      }

      for (const target of targets) {
        const familyRules = target.family === "ipv4" ? ipv4 : ipv6;
        for (const rule of row.ports) {
          const key = `${row.action}|${target.source ?? ""}|${ruleKey(rule)}`;
          if (!familyRules.has(key)) {
            familyRules.set(key, { ...rule, action: row.action, source: target.source });
          }
        }
      }
    }

    return { ipv4: [...ipv4.values()], ipv6: [...ipv6.values()] };
  }

  /**
   * Keep the DOCKER-USER rules in after.rules/after6.rules in step with ufw.
   * Published container ports are DNAT'd through FORWARD and would otherwise
   * ignore the INPUT rules that addFirewallPort/removeFirewallPort manage.
   */
  async syncDockerUserChain(): Promise<void> {
    if (!isUfwInstalled()) return;
    if (this.usesNftablesFirewallBackend()) return;

    const active = runHost("ufw status").includes("Status: active");
    const afterContent = hostFileExists(UFW_AFTER_RULES) ? readHostFile(UFW_AFTER_RULES) : "";
    const after6Content = hostFileExists(UFW_AFTER6_RULES) ? readHostFile(UFW_AFTER6_RULES) : "";

    if (!active) {
      const stripped4 = stripDockerUserBlock(afterContent);
      const stripped6 = stripDockerUserBlock(after6Content);
      if (stripped4 !== afterContent) writeHostFile(UFW_AFTER_RULES, stripped4);
      if (stripped6 !== after6Content) writeHostFile(UFW_AFTER6_RULES, stripped6);

      // Docker may have already populated the chain; drop it so the rules
      // cannot outlive the firewall being turned off.
      try {
        runHost("iptables -F DOCKER-USER");
      } catch {
        // best effort — the chain may not exist
      }
      try {
        runHost("ip6tables -F DOCKER-USER");
      } catch {
        // best effort — the chain may not exist
      }
      return;
    }

    const statusOutput = this.readFirewallStatus();
    const allowedPorts = this.parseFirewallPorts(statusOutput);
    const deniedPorts = this.parseFirewallPorts(statusOutput, ["DENY", "REJECT"]);
    let rules = this.parseDockerUserRules(statusOutput);

    // First run on a host that was already allowing container ports directly:
    // move those published ports into ufw so the generated block lets them
    // through instead of silently dropping them. They are unrestricted, so
    // they belong in both families. This runs once per host: the marker file
    // survives the firewall being disabled, so a port the user removed is not
    // reopened the next time ufw is enabled.
    if (!hostFileExists(DOCKER_USER_MIGRATED)) {
      const migrated = await this.allowPublishedContainerPorts(allowedPorts, deniedPorts);
      writeHostFile(DOCKER_USER_MIGRATED, `${new Date().toISOString()}\n`);
      if (migrated.length > 0) {
        rules = {
          ipv4: withUniqueRules(rules.ipv4, migrated),
          ipv6: withUniqueRules(rules.ipv6, migrated),
        };
      }
    }

    const block4 = dockerUserBlock(this.publicInterfaces("ipv4"), rules.ipv4);
    const block6 = dockerUserBlock(this.publicInterfaces("ipv6"), rules.ipv6);
    const nextAfter = upsertDockerUserBlock(afterContent, block4);
    const nextAfter6 = upsertDockerUserBlock(after6Content, block6);

    // The sync runs on every start; an unchanged pair of files needs neither a
    // write nor a reload.
    if (nextAfter === afterContent && nextAfter6 === after6Content) return;

    writeHostFile(UFW_AFTER_RULES, nextAfter);
    writeHostFile(UFW_AFTER6_RULES, nextAfter6);

    try {
      runHost("ufw reload");
    } catch (err) {
      // A rules file that ufw refuses to load must not be left on disk.
      writeHostFile(UFW_AFTER_RULES, afterContent);
      writeHostFile(UFW_AFTER6_RULES, after6Content);
      try {
        runHost("ufw reload");
      } catch {
        // best effort — the original files are back either way
      }
      throw new SecurityServiceError(
        `Firewall reload failed, Docker rules rolled back: ${(err as Error).message}`,
      );
    }
  }

  private usesNftablesFirewallBackend(): boolean {
    if (!hostFileExists(DOCKER_DAEMON_CONFIG)) return false;
    try {
      const config = JSON.parse(readHostFile(DOCKER_DAEMON_CONFIG)) as Record<string, unknown>;
      return config["firewall-backend"] === "nftables";
    } catch {
      // A malformed daemon.json is Docker's problem, not a reason to skip the
      // firewall rules entirely.
      return false;
    }
  }

  private publicInterfaces(family: "ipv4" | "ipv6"): string[] {
    const command = family === "ipv6" ? "ip -6 -o route show default" : "ip -o route show default";
    let output: string;
    try {
      output = runHost(command);
    } catch {
      // A host with no route for a family is valid — the block still needs
      // its ESTABLISHED return, just no interface rules.
      return [];
    }

    const interfaces: string[] = [];
    for (const line of output.split("\n")) {
      const match = line.match(/\bdev\s+(\S+)/);
      if (match && !interfaces.includes(match[1])) {
        interfaces.push(match[1]);
      }
    }
    return interfaces;
  }

  private async allowPublishedContainerPorts(
    allowed: FirewallPortRule[],
    denied: FirewallPortRule[],
  ): Promise<FirewallPortRule[]> {
    if (!this.dockerService) return [];

    const containers = await this.dockerService.listContainers();
    const seen = new Set(allowed.map(ruleKey));
    const deniedKeys = new Set(denied.map(ruleKey));
    const migrated: FirewallPortRule[] = [];

    for (const container of containers) {
      if (container.state && container.state !== "running") continue;

      for (const published of container.ports ?? []) {
        const hostIp = published.ip ?? "";
        if (hostIp !== "" && hostIp !== "0.0.0.0" && hostIp !== "::") continue;
        if (published.type && published.type !== "tcp" && published.type !== "udp") continue;

        const port = Number(published.public);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

        const protocol = (published.type as FirewallProtocol) || "tcp";
        const key = `${port}/${protocol}`;
        if (seen.has(key)) continue;
        // Never turn an explicit deny or reject into an allow: the block would
        // mirror that rule ahead of the generated allow and win anyway.
        if (deniedKeys.has(key)) continue;

        seen.add(key);
        try {
          runHost(`ufw allow ${port}/${protocol}`);
        } catch (err) {
          throw new SecurityServiceError(
            `Firewall migration failed for ${port}/${protocol}: ${(err as Error).message}`,
          );
        }
        migrated.push({ port, protocol });
      }
    }

    return migrated;
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
