import { writeFileSync } from "node:fs";
import { HostTelemetry } from "../dist/services/HostTelemetry.js";

const bootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cpuRows = [
  [100, 0, 50, 850],
  [110, 0, 60, 930],
  [90, 0, 40, 800],
  [100, 0, 50, 860],
];
const networkRows = [[100, 200], [117, 243], [10, 20], [15, 25]];
const filesystems = [
  [{ target: "/", source: "/dev/vda1", size: "1000", used: "200", avail: "800", fstype: "ext4" }],
  [
    { target: "/", source: "/dev/vda1", size: "1000", used: "200", avail: "800", fstype: "ext4" },
    { target: "/zero", source: "/dev/vda1", size: "0", used: "0", avail: "0", fstype: "ext4" },
    { target: "/mnt/data with space", source: "/dev/vda1", size: "9007199254740991", used: "0", avail: "9007199254740991", fstype: "ext4" },
    { target: "/boundary", source: "/dev/vda1", size: "9007199254740991", used: "9007199254740991", avail: "0", fstype: "ext4" },
  ],
  [{ target: "/", source: "/dev/vda1", size: "1000", used: "200", avail: "800", fstype: "ext4" }],
  [{ target: "/", source: "/dev/vda1", size: "1000", used: "200", avail: "800", fstype: "ext4" }],
];

function enoent(message) {
  const error = new Error(message);
  error.code = "ENOENT";
  return error;
}
function commandError(code, stderr, message) {
  const error = new Error(message);
  error.code = code;
  error.stderr = stderr;
  return error;
}
function procStat(row) {
  return `cpu ${row[0]} ${row[1]} ${row[2]} ${row[3]} 0 0 0 0\ncpu0 1 0 1 8 0 0 0 0\ncpu1 1 0 1 8 0 0 0 0\n`;
}
function procNet(row, extra = 0) {
  const line = (name, rx, tx) => ` ${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
  return `Inter-| Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n${line("eth0", row[0], row[1])}\n${line("veth-test", 9000 + extra, 8000 + extra)}\n`;
}

function makeProducer({ missingBoot = false } = {}) {
  const calls = [];
  let cpuRead = 0;
  let networkRead = 0;
  let memoryRead = 0;
  let diskRead = 0;
  let wallTick = 0;
  let monotonicTick = 0;
  const now = () => Date.parse("2026-10-29T12:30:45.000Z") + wallTick++;
  const monotonicNow = () => (monotonicTick++ * 0.01);
  const command = async (file, args) => {
    calls.push({ file, args });
    if (file === "readlink" && args[0] === "/proc/self/ns/pid") return { stdout: "pid:[4026531836]", stderr: "" };
    if (file === "readlink" && args[0] === "/proc/1/ns/pid") return { stdout: "pid:[4026531836]", stderr: "" };
    if (file === "stat" && args[0] === "-Lc") return { stdout: "2049:2", stderr: "" };
    if (file !== "nsenter") throw enoent(`unexpected command ${file}`);
    const delimiter = args.indexOf("--");
    const hostFile = args[delimiter + 1];
    const hostArgs = args.slice(delimiter + 2);
    if (hostFile === "/usr/bin/test" && hostArgs.join(" ") === "-x /sbin/init") return { stdout: "", stderr: "" };
    if (hostFile === "/usr/bin/stat") {
      const path = hostArgs.at(-1);
      if (path === "/proc/1/root/.dockerenv" || path === "/proc/1/root/run/.containerenv") {
        throw commandError(1, `stat: cannot stat '${path}': No such file or directory\n`, "container marker absent");
      }
      if (hostArgs.join(" ") === "-Lc %d:%i /") return { stdout: "2049:2", stderr: "" };
      throw enoent(`unexpected host stat arguments: ${hostArgs.join(" ")}`);
    }
    if (hostFile === "/bin/cat") {
      const path = hostArgs[0];
      if (path === "/proc/1/comm") return { stdout: "systemd\n", stderr: "" };
      if (path === "/proc/1/root/.dockerenv" || path === "/proc/1/root/run/.containerenv") throw enoent("not present");
      if (path === "/proc/1/mountinfo") return { stdout: "1 0 8:1 / / rw,relatime - ext4 /dev/root rw\n", stderr: "" };
      if (path === "/proc/sys/kernel/random/boot_id") return { stdout: missingBoot ? "" : `${bootId}\n`, stderr: "" };
      if (path === "/proc/stat") return { stdout: procStat(cpuRows[Math.min(cpuRead++, cpuRows.length - 1)]), stderr: "" };
      if (path === "/sys/devices/system/cpu/online") return { stdout: "0-1\n", stderr: "" };
      if (path === "/proc/meminfo") {
        memoryRead++;
        return { stdout: memoryRead === 4 ? "MemTotal: 1024 kB\n" : "MemTotal: 1024 kB\nMemAvailable: 512 kB\n", stderr: "" };
      }
      if (path === "/proc/net/dev") return { stdout: procNet(networkRows[Math.min(networkRead++, networkRows.length - 1)]), stderr: "" };
    }
    if (hostFile === "/sbin/ip" && hostArgs.join(" ") === "-j route show default") return { stdout: '[{"dev":"eth0"}]', stderr: "" };
    if (hostFile === "/sbin/ip" && hostArgs.join(" ") === "-6 -j route show default") return { stdout: "[]", stderr: "" };
    if (hostFile === "/usr/bin/findmnt") {
      const index = diskRead++;
      if (index >= 3) throw enoent("findmnt unavailable for partial-failure sample");
      return { stdout: JSON.stringify({ filesystems: filesystems[index] }), stderr: "" };
    }
    throw enoent(`unexpected host command ${hostFile} ${hostArgs.join(" ")}`);
  };
  return { telemetry: new HostTelemetry({ command, now, monotonicNow }), calls };
}

const producer = makeProducer();
const observations = [];
for (let i = 0; i < 4; i++) observations.push(await producer.telemetry.collect());
const missingBoot = await makeProducer({ missingBoot: true }).telemetry.collect();

const networkReads = producer.calls.filter(call => call.file === "nsenter" && call.args.includes("/proc/net/dev"));
const routeReads = producer.calls.filter(call => call.file === "nsenter" && call.args.includes("route") && call.args.includes("default"));
if (networkReads.length !== 4 || routeReads.length !== 8) throw new Error("Producer did not issue host-network route and counter reads for each collection.");
if (networkReads.some(call => !call.args.includes("--net") || !call.args.includes("--root=/proc/1/root"))) throw new Error("Producer network reads did not enter the host network namespace and root.");

const expected = [
  {
    name: "first-sample",
    collectors: {
      cpu: { status: "first_sample", values: null },
      memory: { status: "success", values: { used_bytes: 524288, total_bytes: 1048576 } },
      network: { status: "first_sample", values: null },
      disk: { status: "success", values: { mounts: [{ mount: "/", size_bytes: 1000, used_bytes: 200, available_bytes: 800, filesystem: "/dev/vda1", fs_type: "ext4" }] } },
    },
  },
  {
    name: "measured-success-boundaries",
    collectors: {
      cpu: { status: "success", values: { utilisation_pct: 20, cores: 2, measured_duration_seconds: 0.02 } },
      memory: { status: "success", values: { used_bytes: 524288, total_bytes: 1048576 } },
      network: { status: "success", values: { rx_bytes_delta: 17, tx_bytes_delta: 43, measured_duration_seconds: 0.02 } },
      disk: { status: "success", values: { mounts: [
        { mount: "/", size_bytes: 1000, used_bytes: 200, available_bytes: 800, filesystem: "/dev/vda1", fs_type: "ext4" },
        { mount: "/zero", size_bytes: 0, used_bytes: 0, available_bytes: 0, filesystem: "/dev/vda1", fs_type: "ext4" },
        { mount: "/mnt/data with space", size_bytes: 9007199254740991, used_bytes: 0, available_bytes: 9007199254740991, filesystem: "/dev/vda1", fs_type: "ext4" },
        { mount: "/boundary", size_bytes: 9007199254740991, used_bytes: 9007199254740991, available_bytes: 0, filesystem: "/dev/vda1", fs_type: "ext4" },
      ] } },
    },
  },
  {
    name: "counter-reset",
    collectors: {
      cpu: { status: "reset", values: null },
      memory: { status: "success", values: { used_bytes: 524288, total_bytes: 1048576 } },
      network: { status: "reset", values: null },
      disk: { status: "success", values: { mounts: [{ mount: "/", size_bytes: 1000, used_bytes: 200, available_bytes: 800, filesystem: "/dev/vda1", fs_type: "ext4" }] } },
    },
  },
  {
    name: "partial-failure-after-reset",
    collectors: {
      cpu: { status: "success", values: { utilisation_pct: 25, cores: 2, measured_duration_seconds: 0.02 } },
      memory: { status: "unsupported", values: null },
      network: { status: "success", values: { rx_bytes_delta: 5, tx_bytes_delta: 5, measured_duration_seconds: 0.02 } },
      disk: { status: "unsupported", values: null },
    },
  },
];
const series = {
  generated_by: "HostTelemetry with deterministic injected raw command responses and clocks",
  observations: observations.map((observation, index) => ({ name: expected[index].name, observation, expected: expected[index] })),
  missing_boot: { name: "missing-boot-id", observation: missingBoot, expected: null },
};

const json = JSON.stringify(series);
if (process.env.PRODUCER_SERIES_OUTPUT) writeFileSync(process.env.PRODUCER_SERIES_OUTPUT, `${JSON.stringify(series, null, 2)}\n`);
process.stdout.write(`${json}\n`);
