import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/config.js", () => ({ default: { METRICS_NETWORK_INTERFACES: [] } }));
import { HostTelemetry, type HostCommand, type HostCommandResult } from "../../src/services/HostTelemetry.js";
import { MetricsService } from "../../src/services/MetricsService.js";

const bootId = "22222222-2222-4222-8222-222222222222";
const err = (code: string | number, stderr = "") => Object.assign(new Error(stderr || String(code)), { code, stderr });

function cpu(user: string | number, idle: string | number, system: string | number = 0, cores = 1, iowait: string | number = 0, guest = "0 0"): string {
  const aggregate = `cpu ${user} 0 ${system} ${idle} ${iowait} 0 0 0 ${guest}\n`;
  return aggregate + Array.from({ length: cores }, (_, i) => `cpu${i} ${user} 0 ${system} ${idle} ${iowait} 0 0 0 ${guest}\n`).join("");
}
function netRows(interfaces: Record<string, [string | number, string | number]>): string {
  const head = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n";
  return head + Object.entries(interfaces).map(([name, [rx, tx]]) => `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`).join("");
}
const defaultDisk = () => JSON.stringify({ filesystems: [{ target: "/", source: "/dev/vda1", fstype: "ext4", size: "1000", used: "600", avail: "400" }] });
interface Fixture {
  cpu: string;
  network: string;
  mem?: string;
  disks?: string;
  routes4?: string;
  routes6?: string;
  online?: string;
  bootId?: string;
  comm?: string;
  marker?: boolean;
  markerError?: boolean;
  pidNsMismatch?: boolean;
  mountInfo?: string;
  failures?: Record<string, { code: string | number; stderr?: string }>;
}
function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    cpu: cpu(100, 100),
    network: netRows({ eth0: [100, 100], lo: [1, 1] }),
    ...overrides,
  };
}

function hostCommand(data: Fixture): HostCommand {
  return vi.fn(async (file: string, args: string[]): Promise<HostCommandResult> => {
    if (file === "readlink") return { stdout: args[0] === "/proc/1/ns/pid" && data.pidNsMismatch ? "/pid:[2]\n" : "/pid:[1]\n", stderr: "" };
    if (file === "stat") return { stdout: "2049:2\n", stderr: "" };
    const index = args.indexOf("--") + 1;
    const command = args[index];
    const argv = args.slice(index + 1);
    const fail = (key: string): never => { const f = data.failures?.[key]; if (f) throw err(f.code, f.stderr); throw new Error(`unexpected failure: ${key}`); };
    if (command === "/usr/bin/test") return { stdout: "", stderr: "" };
    if (command === "/usr/bin/stat") {
      const path = argv.at(-1);
      if (path === "/proc/1/root/.dockerenv" || path === "/proc/1/root/run/.containerenv") {
        if (data.markerError) throw err(1, "Permission denied");
        if (data.marker) return { stdout: path, stderr: "" };
        throw err(1, "No such file or directory");
      }
      return { stdout: "2049:2\n", stderr: "" };
    }
    if (command === "/bin/cat") {
      const path = argv[0];
      if (data.failures?.[path]) fail(path);
      if (path === "/proc/1/comm") return { stdout: `${data.comm ?? "systemd"}\n`, stderr: "" };
      if (path === "/proc/1/mountinfo") return { stdout: data.mountInfo ?? "36 25 0:32 / / rw - ext4 /dev/sda1 rw\n", stderr: "" };
      if (path === "/proc/sys/kernel/random/boot_id") return { stdout: data.bootId ?? bootId, stderr: "" };
      if (path === "/proc/stat") return { stdout: data.cpu, stderr: "" };
      if (path === "/sys/devices/system/cpu/online") return { stdout: `${data.online ?? "0"}\n`, stderr: "" };
      if (path === "/proc/meminfo") return { stdout: data.mem ?? "MemTotal: 2048 kB\nMemAvailable: 1024 kB\n", stderr: "" };
      if (path === "/proc/net/dev") return { stdout: data.network, stderr: "" };
      throw new Error(`unexpected cat ${path}`);
    }
    if (command === "/sbin/ip") {
      if (data.failures?.ip) fail("ip");
      const isV6 = argv.includes("-6");
      return { stdout: isV6 ? data.routes6 ?? "[]" : data.routes4 ?? '[{"dev":"eth0"}]', stderr: "" };
    }
    if (command === "/usr/bin/findmnt") {
      if (data.failures?.findmnt) fail("findmnt");
      return { stdout: data.disks ?? defaultDisk(), stderr: "" };
    }
    throw new Error(`unexpected command ${file} ${args.join(" ")}`);
  });
}
function telemetry(data: Fixture, overrides: ConstructorParameters<typeof HostTelemetry>[0] = {}) {
  return new HostTelemetry({ command: hostCommand(data), now: () => 1_800_000_000_000, ...overrides });
}

describe("HostTelemetry canonical observations", () => {
  it("emits a full canonical observation, preserves disk provenance, and succeeds on zero byte deltas", async () => {
    const data = fixture();
    let mono = 10;
    const source = telemetry(data, { monotonicNow: () => mono });
    const service = new MetricsService(source);
    const first = await service.collect();
    expect(first).toMatchObject({ schema_version: 1, boot_id: bootId });
    expect(first?.collectors).toMatchObject({
      cpu: { status: "first_sample" }, network: { status: "first_sample" },
      memory: { status: "success", used_bytes: 1_048_576, total_bytes: 2_097_152 },
      disk: { status: "success", mounts: [{ mount: "/", filesystem: "/dev/vda1", fs_type: "ext4", size_bytes: 1000, used_bytes: 600, available_bytes: 400 }] },
    });
    mono = 11;
    const second = await service.collect();
    expect(second?.collectors.network).toMatchObject({ status: "success", rx_bytes_delta: 0, tx_bytes_delta: 0, measured_duration_seconds: 1 });
    expect(first?.collectors.network.status).toBe("first_sample");
  });

  it.each([
    [Number.NaN, "reset"], [-1, "reset"], [0, "reset"], [0.0000009, "reset"],
    [0.000001, "success"], [Number.MAX_SAFE_INTEGER, "success"], [Number.MAX_SAFE_INTEGER + 1, "reset"],
  ] as const)("validates measured duration boundary %s", async (elapsed, expected) => {
    const data = fixture();
    const times = [0, 0, elapsed, elapsed];
    const monotonicNow = vi.fn(() => times.shift() ?? elapsed);
    const source = telemetry(data, { monotonicNow });
    await source.collect();
    data.cpu = cpu(101, 100);
    data.network = netRows({ eth0: [100, 100], lo: [1, 1] });
    const result = await source.collect();
    expect(result?.collectors.cpu.status).toBe(expected);
    expect(result?.collectors.network.status).toBe(expected);
    if (expected === "success") expect(result?.collectors.network).toHaveProperty("measured_duration_seconds");
  });

  it("uses BigInt for absolute counters and accepts a small safe delta above 2^53", async () => {
    const base = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
    const data = fixture({ network: netRows({ eth0: [base.toString(), base.toString()], lo: [1, 1] }) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.network = netRows({ eth0: [(base + 17n).toString(), (base + 19n).toString()], lo: [1, 1] });
    mono = 2;
    expect((await source.collect())?.collectors.network).toMatchObject({ status: "success", rx_bytes_delta: 17, tx_bytes_delta: 19 });
  });

  it("rejects deltas and absolute disk counters beyond safe JSON integers", async () => {
    const data = fixture({ disks: JSON.stringify({ filesystems: [{ target: "/", source: "disk", fstype: "ext4", size: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n), used: "1", avail: "1" }] }) });
    const result = await telemetry(data).collect();
    expect(result?.collectors.disk.status).toBe("failed");
  });

  it("excludes guest fields from CPU totals and resets on a component decrease even if the aggregate rises", async () => {
    const guestData = fixture({ cpu: "cpu 100 0 0 100 0 0 0 0 1 1\ncpu0 100 0 0 100 0 0 0 0 1 1\n" });
    let mono = 1;
    const guestSource = telemetry(guestData, { monotonicNow: () => mono });
    await guestSource.collect();
    guestData.cpu = "cpu 200 0 0 200 0 0 0 0 999999 999999\ncpu0 200 0 0 200 0 0 0 0 999999 999999\n";
    mono = 2;
    expect((await guestSource.collect())?.collectors.cpu).toMatchObject({ status: "success", utilisation_pct: 50 });

    const componentData = fixture({ cpu: cpu(100, 100) });
    mono = 1;
    const componentSource = telemetry(componentData, { monotonicNow: () => mono });
    await componentSource.collect();
    componentData.cpu = cpu(90, 100, 200);
    mono = 2;
    expect((await componentSource.collect())?.collectors.cpu.status).toBe("reset");
  });

  it("resets CPU when the core count changes independently of the online-list string", async () => {
    const data = fixture({ cpu: cpu(100, 100, 0, 1), online: "0" });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.cpu = cpu(110, 110, 0, 2); mono = 2;
    expect((await source.collect())?.collectors.cpu.status).toBe("reset");
  });

  it("reports a zero CPU counter delta as reset instead of healthy zero utilisation", async () => {
    const data = fixture({ cpu: cpu(0, 0) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    mono = 2;
    expect((await source.collect())?.collectors.cpu.status).toBe("reset");
  });

  it("resets on core hotplug, boot change, and wall-clock rollback", async () => {
    const data = fixture();
    let mono = 1;
    let wall = 1_800_000_000_000;
    const source = new HostTelemetry({ command: hostCommand(data), now: () => wall, monotonicNow: () => mono });
    await source.collect();
    mono = 2; data.online = "0-1";
    expect((await source.collect())?.collectors.cpu.status).toBe("reset");
    data.online = "0"; data.bootId = "33333333-3333-4333-8333-333333333333"; mono = 3;
    const reboot = await source.collect();
    expect(reboot?.collectors.cpu.status).toBe("reset");
    expect(reboot?.collectors.network.status).toBe("reset");
    wall -= 1000; mono = 4;
    const rolledBack = await source.collect();
    expect(rolledBack?.collectors.cpu.status).toBe("reset");
    expect(rolledBack?.collectors.network.status).toBe("reset");
  });

  it.each([
    "00000000-0000-0000-0000-000000000000",
    "22222222-2222-0222-4222-222222222222",
    "22222222-2222-4222-7222-222222222222",
  ])("refuses invalid host boot UUID %s", async badId => {
    expect(await telemetry(fixture({ bootId: badId })).collect()).toBeNull();
  });

  it("unions and deduplicates IPv4/IPv6 route devices, including a routed bridge and multipath", async () => {
    const routes4 = JSON.stringify([{ dev: "br0" }, { nexthops: [{ dev: "eth0" }, { dev: "br0" }] }]);
    const routes6 = JSON.stringify([{ dev: "ens3" }, { dev: "br0" }]);
    const data = fixture({ routes4, routes6, network: netRows({ eth0: [1, 1], br0: [2, 2], ens3: [3, 3], veth0: [1000, 1000], lo: [1, 1] }) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.network = netRows({ eth0: [11, 11], br0: [22, 22], ens3: [33, 33], veth0: [9000, 9000], lo: [1, 1] }); mono = 2;
    expect((await source.collect())?.collectors.network).toMatchObject({ rx_bytes_delta: 60, tx_bytes_delta: 60 });
  });

  it("fails malformed route JSON rather than treating a non-array as a known empty route set", async () => {
    const data = fixture({ routes4: '{"dev":"eth0"}', routes6: "[]" });
    expect((await telemetry(data).collect())?.collectors.network.status).toBe("failed");
    const malformedHop = fixture({ routes4: '[{"nexthops":[{"gateway":"192.0.2.1"}]}]', routes6: "[]" });
    expect((await telemetry(malformedHop).collect())?.collectors.network.status).toBe("failed");
  });

  it("resets if one selected NIC decreases even when another increases", async () => {
    const data = fixture({ routes4: '[{"dev":"eth0"},{"dev":"br0"}]', network: netRows({ eth0: [100, 100], br0: [100, 100] }) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.network = netRows({ eth0: [90, 110], br0: [1000, 1000] }); mono = 2;
    expect((await source.collect())?.collectors.network.status).toBe("reset");
  });

  it("resets rather than bridging deltas across a default-route interface change", async () => {
    const data = fixture({ routes4: '[{"dev":"eth0"}]', network: netRows({ eth0: [10, 10], br0: [20, 20] }) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.routes4 = '[{"dev":"br0"}]'; data.network = netRows({ eth0: [100, 100], br0: [30, 30] }); mono = 2;
    expect((await source.collect())?.collectors.network.status).toBe("reset");
  });

  it("accepts a MAX_SAFE_INTEGER delta and resets for a larger BigInt delta", async () => {
    const data = fixture({ network: netRows({ eth0: [0, 0] }) });
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.network = netRows({ eth0: [Number.MAX_SAFE_INTEGER, 0] }); mono = 2;
    expect((await source.collect())?.collectors.network).toMatchObject({ status: "success", rx_bytes_delta: Number.MAX_SAFE_INTEGER });

    const tooLargeData = fixture({ network: netRows({ eth0: [0, 0] }) });
    mono = 1;
    const tooLargeSource = telemetry(tooLargeData, { monotonicNow: () => mono });
    await tooLargeSource.collect();
    tooLargeData.network = netRows({ eth0: [(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(), 0] }); mono = 2;
    expect((await tooLargeSource.collect())?.collectors.network.status).toBe("reset");
  });

  it("rejects duplicate or truncated proc network counter rows", async () => {
    for (const network of [
      netRows({ eth0: [1, 1] }) + "eth0: 2 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n",
      "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\neth0: 1 0 0\n",
    ]) {
      expect((await telemetry(fixture({ network })).collect())?.collectors.network.status).toBe("failed");
    }
  });

  it("recovers after a failed route read using the full actual elapsed interval", async () => {
    const data = fixture();
    let mono = 1;
    const source = telemetry(data, { monotonicNow: () => mono });
    await source.collect();
    data.failures = { ip: { code: 1, stderr: "Permission denied" } }; mono = 2;
    expect((await source.collect())?.collectors.network.status).toBe("failed");
    data.failures = undefined; data.network = netRows({ eth0: [190, 190], lo: [1, 1] }); mono = 10;
    expect((await source.collect())?.collectors.network).toMatchObject({ status: "success", rx_bytes_delta: 90, measured_duration_seconds: 9 });
  });

  it("distinguishes configured missing NIC failure from no default-route support", async () => {
    const data = fixture({ network: netRows({ eth0: [1, 1] }) });
    expect((await telemetry(data, { networkInterfaces: ["missing0"] }).collect())?.collectors.network.status).toBe("failed");
    expect((await telemetry(fixture({ routes4: "[]", routes6: "[]" })).collect())?.collectors.network.status).toBe("unsupported");
    expect(() => new HostTelemetry({ networkInterfaces: ["eth0", "eth0"] })).toThrow();
  });

  it("requires MemAvailable and classifies memory permissions and invalid counters", async () => {
    expect((await telemetry(fixture({ mem: "MemTotal: 100 kB\n" })).collect())?.collectors.memory.status).toBe("unsupported");
    expect((await telemetry(fixture({ failures: { "/proc/meminfo": { code: 1, stderr: "Permission denied" } } })).collect())?.collectors.memory.status).toBe("failed");
    for (const mem of ["MemTotal: 0 kB\nMemAvailable: 0 kB\n", "MemTotal: 100 kB\nMemAvailable: 101 kB\n", "MemTotal: 9007199254740992 kB\nMemAvailable: 1 kB\n"]) {
      expect((await telemetry(fixture({ mem })).collect())?.collectors.memory.status).toBe("failed");
    }
  });

  it("reports a verified empty disk inventory as success and preserves full whitespace mounts and metadata", async () => {
    expect((await telemetry(fixture({ disks: '{"filesystems":[]}' })).collect())?.collectors.disk).toMatchObject({ status: "success", mounts: [] });
    const name = "/var/lib/my mounts/with\nnewline";
    const disks = JSON.stringify({ filesystems: [{ target: name, source: "/dev/a", fstype: "xfs", size: "100", used: "40", avail: "60" }] });
    expect((await telemetry(fixture({ disks })).collect())?.collectors.disk).toMatchObject({ mounts: [{ mount: name, filesystem: "/dev/a", fs_type: "xfs" }] });
  });

  it.each([
    ["malformed JSON", "{"],
    ["duplicate mount", JSON.stringify({ filesystems: ["/", "/"].map(target => ({ target, source: "x", fstype: "ext4", size: "1", used: "0", avail: "1" })) })],
    ["too many mounts", JSON.stringify({ filesystems: Array.from({ length: 129 }, (_, i) => ({ target: `/m${i}`, source: "x", fstype: "ext4", size: "1", used: "0", avail: "1" })) })],
    ["oversized UTF-8 mount", JSON.stringify({ filesystems: [{ target: `/${"é".repeat(256)}`, source: "x", fstype: "ext4", size: "1", used: "0", avail: "1" }] })],
    ["invalid source text", JSON.stringify({ filesystems: [{ target: "/", source: 42, fstype: "ext4", size: "1", used: "0", avail: "1" }] })],
    ["invalid filesystem type text", JSON.stringify({ filesystems: [{ target: "/", source: "x", fstype: "é".repeat(257), size: "1", used: "0", avail: "1" }] })],
    ["negative bytes", JSON.stringify({ filesystems: [{ target: "/", source: "x", fstype: "ext4", size: "1", used: "-1", avail: "1" }] })],
    ["unsafe bytes", JSON.stringify({ filesystems: [{ target: "/", source: "x", fstype: "ext4", size: "9007199254740992", used: "0", avail: "1" }] })],
  ])("fails the whole disk inventory for %s", async (_name, disks) => {
    expect((await telemetry(fixture({ disks })).collect())?.collectors.disk.status).toBe("failed");
  });

  it("distinguishes missing tools from permission and timeout failures", async () => {
    const missing = err(127, "/usr/bin/findmnt: No such file or directory");
    const denied = err(1, "Permission denied");
    const timeout = err("ETIMEDOUT", "timed out");
    expect((await telemetry(fixture({ failures: { findmnt: { code: missing.code as number, stderr: missing.stderr } } })).collect())?.collectors.disk.status).toBe("unsupported");
    expect((await telemetry(fixture({ failures: { findmnt: { code: denied.code as number, stderr: denied.stderr } } })).collect())?.collectors.disk.status).toBe("failed");
    expect((await telemetry(fixture({ failures: { findmnt: { code: timeout.code, stderr: timeout.stderr } } })).collect())?.collectors.disk.status).toBe("failed");
    expect((await telemetry(fixture({ failures: { ip: { code: 127, stderr: "/sbin/ip: No such file or directory" } } })).collect())?.collectors.network.status).toBe("unsupported");
  });

  it("returns null for unsupported PID 1, marker probe errors, namespace mismatch, and container roots", async () => {
    for (const data of [fixture({ comm: "node" }), fixture({ marker: true }), fixture({ markerError: true }), fixture({ pidNsMismatch: true }), fixture({ mountInfo: "1 2 0:1 / / rw - overlay overlay rw\n" })]) {
      expect(await telemetry(data).collect()).toBeNull();
    }
  });

  it("fails closed if the final envelope clock precedes collector timestamps", async () => {
    let calls = 0;
    const source = new HostTelemetry({ command: hostCommand(fixture()), now: () => ++calls <= 8 ? 2_000 : 1_000, monotonicNow: () => 1 });
    expect(await source.collect()).toBeNull();
  });

  it("coalesces concurrent collection without overlapping raw probes", async () => {
    const base = hostCommand(fixture());
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const command: HostCommand = async (file, args) => {
      const path = args.at(-1);
      if (file === "nsenter" && args.includes("/proc/meminfo")) { entered(); await blocked; }
      return base(file, args);
    };
    const source = telemetry(fixture(), { command });
    const first = source.collect();
    await started;
    const second = source.collect();
    expect(second).toBe(first);
    release();
    expect(await first).toBe(await second);
  });
});
