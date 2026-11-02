import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  CpuObservation,
  DiskMountObservation,
  DiskObservation,
  MemoryObservation,
  NetworkObservation,
  ServerObservation,
} from "../types/ServerObservation.js";

const execFileAsync = promisify(execFile);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BUFFER = 2 * 1024 * 1024;
const TIMEOUT_MS = 4000;

export interface HostCommandResult { stdout: string; stderr: string }
export type HostCommand = (file: string, args: string[]) => Promise<HostCommandResult>;
export interface HostTelemetryOptions {
  command?: HostCommand;
  now?: () => number;
  monotonicNow?: () => number;
  networkInterfaces?: string[];
}

interface CpuSnapshot { counters: bigint[]; cores: number }
interface NetworkSnapshot { counters: Map<string, [bigint, bigint]> }

function realCommand(file: string, args: string[]): Promise<HostCommandResult> {
  return execFileAsync(file, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}
function validNumber(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER; }
function boundedNumber(n: bigint): number | null { return n >= 0n && n <= MAX_SAFE ? Number(n) : null; }
function stamp(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("invalid clock");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}
function fail(status: "failed" | "unsupported", observed_at: string) {
  return { status, observed_at } as const;
}
function commandFailure(error: unknown): "failed" | "unsupported" {
  if (typeof error !== "object" || error === null || !("code" in error)) return "failed";
  if (error.code === "ENOENT") return "unsupported";
  const rawStderr = "stderr" in error ? error.stderr : "";
  const stderr = typeof rawStderr === "string" ? rawStderr : Buffer.isBuffer(rawStderr) ? rawStderr.toString("utf8") : "";
  const missing = /(?:not found|No such file or directory)/i.test(stderr);
  return missing && (Number(error.code) === 127 || Number(error.code) === 1) ? "unsupported" : "failed";
}
function measuredDuration(elapsed: number): number | null {
  if (!Number.isFinite(elapsed) || elapsed < 0.000001 || elapsed > Number.MAX_SAFE_INTEGER) return null;
  const rounded = Math.round(elapsed * 1e6) / 1e6;
  return validNumber(rounded) && rounded >= 0.000001 ? rounded : null;
}

/** Read-only Linux host telemetry. Commands use fixed argv and enter PID 1's namespaces and root. */
export class HostTelemetry {
  private readonly command: HostCommand;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private cpuBaseline?: { snapshot: CpuSnapshot; at: number; wallAt: number; online: string; bootId: string };
  private networkBaseline?: { snapshot: NetworkSnapshot; at: number; wallAt: number; bootId: string };
  private currentBootId?: string;
  private collecting: Promise<ServerObservation | null> | null = null;
  private readonly explicitInterfaces?: Set<string>;

  constructor(options: HostTelemetryOptions = {}) {
    this.command = options.command ?? realCommand;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => Number(process.hrtime.bigint()) / 1e9);
    if (options.networkInterfaces) {
      if (!options.networkInterfaces.length || options.networkInterfaces.some(n => !/^[A-Za-z0-9_.:-]{1,15}$/.test(n) || n === "lo") || new Set(options.networkInterfaces).size !== options.networkInterfaces.length) throw new Error("invalid network interface allowlist");
      this.explicitInterfaces = new Set(options.networkInterfaces);
    }
  }

  collect(): Promise<ServerObservation | null> {
    if (this.collecting) return this.collecting;
    this.collecting = this.collectOnce().catch(() => null).finally(() => { this.collecting = null; });
    return this.collecting;
  }

  private async host(file: string, args: string[] = []): Promise<HostCommandResult> {
    return this.command("nsenter", ["--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--root=/proc/1/root", "--wd=/", "--", file, ...args]);
  }

  private async collectOnce(): Promise<ServerObservation | null> {
    if (process.platform !== "linux") return null;
    const provenance = await this.verifyHost();
    if (!provenance) return null;
    const boot = await this.read("/proc/sys/kernel/random/boot_id");
    const bootId = boot?.trim().toLowerCase();
    if (!bootId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bootId)) return null;
    this.currentBootId = bootId;

    const [cpu, memory, network, disk] = await Promise.all([
      this.collectCpu(), this.collectMemory(), this.collectNetwork(), this.collectDisk(),
    ]);
    const completed = this.now();
    // If wall time moved behind any collector timestamp, fail closed rather than inventing a future timestamp.
    let envelope: string;
    try {
      const collectorTimes = [cpu, memory, network, disk].map(c => Date.parse(c.observed_at));
      if (collectorTimes.some(t => !Number.isFinite(t)) || completed < Math.max(...collectorTimes)) return null;
      envelope = stamp(completed);
    } catch { return null; }
    return { schema_version: 1, sample_id: randomUUID(), boot_id: bootId, observed_at: envelope, collectors: { cpu, memory, network, disk } };
  }

  /** Fail closed on container PID 1, container root markers, or a container root mount. */
  private async verifyHost(): Promise<boolean> {
    try {
      const [comm, rootMarker, mountInfo, selfNs, pidOneNs, init] = await Promise.all([
        this.read("/proc/1/comm"),
        Promise.all([this.markerExists("/proc/1/root/.dockerenv"), this.markerExists("/proc/1/root/run/.containerenv")]).then(values => values.some(v => v)),
        this.read("/proc/1/mountinfo"),
        this.command("readlink", ["/proc/self/ns/pid"]).then(r => r.stdout, () => null),
        this.command("readlink", ["/proc/1/ns/pid"]).then(r => r.stdout, () => null),
        this.host("/usr/bin/test", ["-x", "/sbin/init"]).then(() => true, () => false),
      ]);
      if (!comm || !["systemd", "init"].includes(comm.trim()) || rootMarker || !mountInfo || !selfNs || selfNs.trim() !== pidOneNs?.trim() || !init) return false;
      const rootLine = mountInfo.split("\n").find(line => line.split(" ")[4] === "/");
      if (!rootLine || / - (overlay|aufs|fuse\.|9p) /.test(rootLine)) return false;
      // Confirm the entered root is the same host root, not the agent's container root.
      const rootId = await this.host("/usr/bin/stat", ["-Lc", "%d:%i", "/"]);
      const procRootId = await this.command("stat", ["-Lc", "%d:%i", "/proc/1/root"]);
      return rootId.stdout.trim() !== "" && rootId.stdout.trim() === procRootId.stdout.trim();
    } catch { return false; }
  }

  private async read(path: string): Promise<string | null> {
    try { return (await this.host("/bin/cat", [path])).stdout; } catch { return null; }
  }
  private async markerExists(path: string): Promise<boolean> {
    try {
      await this.host("/usr/bin/stat", ["-L", "-c", "%n", path]);
      return true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      if (Number(code) === 1 && /No such file or directory/.test(stderr)) return false;
      throw error;
    }
  }
  private async readRequired(path: string): Promise<string> {
    return (await this.host("/bin/cat", [path])).stdout;
  }

  private async collectorStamp(): Promise<string> { return stamp(this.now()); }
  private async collectCpu(): Promise<CpuObservation> {
    let atText = await this.collectorStamp();
    try {
      const [stat, onlineText] = await Promise.all([this.readRequired("/proc/stat"), this.readRequired("/sys/devices/system/cpu/online")]);
      const snapshot = parseCpu(stat);
      const online = onlineText.trim();
      const at = this.monotonicNow();
      atText = await this.collectorStamp();
      const prev = this.cpuBaseline;
      const wallAt = Date.parse(atText);
      this.cpuBaseline = { snapshot, at, wallAt, online, bootId: this.currentBootId! };
      if (!prev) return { status: "first_sample", observed_at: atText };
      const elapsed = at - prev.at;
      if (prev.bootId !== this.currentBootId || wallAt < prev.wallAt || online !== prev.online || snapshot.cores !== prev.snapshot.cores || elapsed <= 0 || snapshot.counters.length !== prev.snapshot.counters.length || snapshot.counters.some((n, i) => n < prev.snapshot.counters[i])) return { status: "reset", observed_at: atText };
      const delta = snapshot.counters.map((n, i) => n - prev.snapshot.counters[i]);
      const total = delta.reduce((a, b) => a + b, 0n);
      const idle = delta[3] + delta[4];
      const totalNumber = boundedNumber(total);
      if (!totalNumber || totalNumber <= 0) return { status: "reset", observed_at: atText };
      const duration = measuredDuration(elapsed);
      const busy = boundedNumber(total - idle);
      const pct = busy === null ? Number.NaN : Math.round((busy / totalNumber) * 10000) / 100;
      if (duration === null || !validNumber(pct) || pct > 100) return { status: "reset", observed_at: atText };
      return { status: "success", observed_at: atText, utilisation_pct: pct, measured_duration_seconds: duration, cores: snapshot.cores };
    } catch (error) { return fail(commandFailure(error), atText); }
  }

  private async collectMemory(): Promise<MemoryObservation> {
    let observed_at = await this.collectorStamp();
    try {
      const text = await this.readRequired("/proc/meminfo");
      observed_at = await this.collectorStamp();
      const total = parseMem(text, "MemTotal"); const available = parseMem(text, "MemAvailable");
      if (available === null) return fail("unsupported", observed_at);
      if (total === null || total <= 0 || available > total) return fail("failed", observed_at);
      const used = total - available;
      if (!validNumber(total) || !validNumber(used)) return fail("failed", observed_at);
      return { status: "success", observed_at, used_bytes: used, total_bytes: total };
    } catch (error) { return fail(commandFailure(error), observed_at); }
  }

  private async collectNetwork(): Promise<NetworkObservation> {
    let observed_at = await this.collectorStamp();
    try {
      const routeResults = this.explicitInterfaces ? [] : await Promise.all([
        this.host("/sbin/ip", ["-j", "route", "show", "default"]),
        this.host("/sbin/ip", ["-6", "-j", "route", "show", "default"]),
      ]);
      const dev = await this.readRequired("/proc/net/dev");
      observed_at = await this.collectorStamp();
      let routes: unknown[] = [];
      try { routes = routeResults.flatMap(r => parseRouteJson(r.stdout)); } catch { return fail("failed", observed_at); }
      const selected = this.explicitInterfaces ?? routeInterfaces(routes);
      if (!selected.size) {
        if (!this.explicitInterfaces) this.networkBaseline = undefined;
        return fail("unsupported", observed_at);
      }
      let all: Map<string, [bigint, bigint]>;
      try { all = parseNetwork(dev); } catch { return fail("failed", observed_at); }
      if ([...selected].some(name => !all.has(name))) return fail("failed", observed_at);
      const current: NetworkSnapshot = { counters: new Map([...selected].map(n => [n, all.get(n)!])) };
      const at = this.monotonicNow(); const wallAt = Date.parse(observed_at); const prev = this.networkBaseline; this.networkBaseline = { snapshot: current, at, wallAt, bootId: this.currentBootId! };
      if (!prev) return { status: "first_sample", observed_at };
      const elapsed = at - prev.at;
      if (prev.bootId !== this.currentBootId || wallAt < prev.wallAt || !Number.isFinite(elapsed) || elapsed <= 0 || prev.snapshot.counters.size !== current.counters.size) return { status: "reset", observed_at };
      let rx = 0n; let tx = 0n;
      for (const [name, [newRx, newTx]] of current.counters) {
        const old = prev.snapshot.counters.get(name);
        if (!old || newRx < old[0] || newTx < old[1]) return { status: "reset", observed_at };
        rx += newRx - old[0]; tx += newTx - old[1];
      }
      const rxNum = boundedNumber(rx); const txNum = boundedNumber(tx);
      const duration = measuredDuration(elapsed);
      if (rxNum === null || txNum === null || duration === null) return { status: "reset", observed_at };
      return { status: "success", observed_at, rx_bytes_delta: rxNum, tx_bytes_delta: txNum, measured_duration_seconds: duration };
    } catch (error) { return fail(commandFailure(error), observed_at); }
  }

  private async collectDisk(): Promise<DiskObservation> {
    let observed_at = await this.collectorStamp();
    try {
      let result: HostCommandResult;
      try {
        result = await this.host("/usr/bin/findmnt", ["--json", "--bytes", "--df", "--list", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"]);
      } catch (error) { return fail(commandFailure(error), observed_at); }
      observed_at = await this.collectorStamp();
      let parsed: any;
      try { parsed = JSON.parse(result.stdout); } catch { return fail("failed", observed_at); }
      if (!Array.isArray(parsed.filesystems)) return fail("failed", observed_at);
      if (parsed.filesystems.length > 128) return fail("failed", observed_at);
      const mounts: DiskMountObservation[] = [];
      const seen = new Set<string>();
      for (const fs of parsed.filesystems) {
        if (typeof fs.target !== "string" || fs.target.length === 0 || Buffer.from(fs.target, "utf8").toString("utf8") !== fs.target || Buffer.byteLength(fs.target, "utf8") > 512 || seen.has(fs.target)) return fail("failed", observed_at);
        const filesystem = parseOptionalMountText(fs.source);
        const fsType = parseOptionalMountText(fs.fstype);
        if (filesystem === false || fsType === false) return fail("failed", observed_at);
        // Filter pseudo filesystems only; never discard the host root, including overlay roots.
        if (fs.target !== "/" && ["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs", "pstore", "debugfs", "tracefs", "configfs", "mqueue", "hugetlbfs"].includes(fs.fstype)) continue;
        const size = parseSafeInteger(fs.size); const used = parseSafeInteger(fs.used); const available = parseSafeInteger(fs.avail);
        if (size === null || used === null || available === null || used > size || available > size || used + available > size) return fail("failed", observed_at);
        seen.add(fs.target);
        mounts.push({ mount: fs.target, size_bytes: size, used_bytes: used, available_bytes: available,
          ...(typeof filesystem === "string" ? { filesystem } : {}), ...(typeof fsType === "string" ? { fs_type: fsType } : {}) });
      }
      return { status: "success", observed_at, mounts };
    } catch { return fail("failed", observed_at); }
  }
}

function parseSafeInteger(value: unknown): number | null { if (!(typeof value === "string" || typeof value === "number") || !/^\d+$/.test(String(value))) return null; const n = BigInt(value); return boundedNumber(n); }
function parseOptionalMountText(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value || Buffer.byteLength(value, "utf8") > 512) return false;
  return value;
}
function parseMem(text: string, key: string): number | null {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB\\s*$`, "m"));
  if (!m) return null;
  const bytes = BigInt(m[1]) * 1024n;
  return boundedNumber(bytes);
}
function parseCpu(text: string): CpuSnapshot {
  const line = text.split("\n").find(l => /^cpu\s/.test(l));
  if (!line) throw new Error("aggregate cpu counters missing");
  const parts = line.trim().split(/\s+/).slice(1, 9);
  if (parts.length !== 8 || parts.some(p => !/^\d+$/.test(p))) throw new Error("invalid aggregate cpu counters");
  const cores = [...text.matchAll(/^cpu\d+\s/mg)].length;
  if (cores < 1) throw new Error("cpu core count unavailable");
  return { counters: parts.map(BigInt), cores };
}
function parseNetwork(text: string): Map<string, [bigint, bigint]> {
  const map = new Map<string, [bigint, bigint]>();
  for (const line of text.split("\n").slice(2)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*([^:]+):\s*(.*)$/); if (!match) throw new Error("invalid network interface row");
    const iface = match[1].trim();
    const fields = match[2].trim().split(/\s+/);
    if (!iface || fields.length !== 16 || fields.some(f => !/^\d+$/.test(f))) throw new Error("invalid network counters");
    if (iface === "lo") continue;
    if (map.has(iface)) throw new Error("duplicate network interface");
    map.set(iface, [BigInt(fields[0]), BigInt(fields[8])]);
  }
  return map;
}
function validInterfaceName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 15 && /^[A-Za-z0-9_.:-]+$/.test(name);
}
function parseRouteJson(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("route output must be a list");
  for (const route of parsed) {
    if (!route || typeof route !== "object" || Array.isArray(route)) throw new Error("invalid default route");
    const record = route as Record<string, unknown>;
    const hasDevice = Object.prototype.hasOwnProperty.call(record, "dev");
    if (hasDevice && !validInterfaceName(record.dev)) throw new Error("invalid route device");
    if (Object.prototype.hasOwnProperty.call(record, "nexthops")) {
      if (!Array.isArray(record.nexthops) || record.nexthops.length === 0 || record.nexthops.some(hop => !hop || typeof hop !== "object" || Array.isArray(hop) || !validInterfaceName((hop as Record<string, unknown>).dev))) throw new Error("invalid route nexthops");
    } else if (!hasDevice) throw new Error("route has no selected device");
  }
  return parsed;
}
function routeInterfaces(routes: unknown): Set<string> {
  if (!Array.isArray(routes)) throw new Error("host route data is not a list");
  const names = new Set<string>();
  for (const route of routes) {
    if (route && typeof route.dev === "string") names.add(route.dev);
    if (route && Array.isArray(route.nexthops)) for (const hop of route.nexthops) names.add(hop.dev);
  }
  names.delete("lo");
  return names;
}

export default HostTelemetry;
