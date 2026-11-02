import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const docker = process.env.DOCKER_BIN || "sudo -n docker";
const dockerArgs = docker.split(/\s+/);
const run = (args, options = {}) => execFileSync(dockerArgs[0], [...dockerArgs.slice(1), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, ...options }).trim();
const tag = `serversinc-host-telemetry-it:${process.pid}-${Date.now()}`;
const label = `org.serversinc.test.run=${randomUUID()}`;
const evidence = { image: tag, label, cases: {} };
let imageBuilt = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dockerRun(args) {
  return run(["run", "--rm", "--label", label, ...args, tag, "node", "-e", `
    const { HostTelemetry } = require('./dist/services/HostTelemetry.js');
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const exec = promisify(execFile);
    const calls = [];
    const command = async (file, argv) => {
      const result = await exec(file, argv, { encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
      calls.push({ file, args: argv, stdout: result.stdout });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    (async () => {
      const telemetry = new HostTelemetry({ command });
      const observations = [];
      for (let i = 0; i < 3; i++) observations.push(await telemetry.collect());
      const fs = require('fs');
      const namespaces = Object.fromEntries(['pid','mnt','net','uts','ipc'].map(name => [name, { self: fs.readlinkSync('/proc/self/ns/' + name), init: fs.readlinkSync('/proc/1/ns/' + name) }]));
      const hostNetns = await command('nsenter', ['--target','1','--net','--root=/proc/1/root','--wd=/','--','readlink','/proc/self/ns/net']);
      process.stdout.write(JSON.stringify({ observations, calls, namespaces, hostNetns: hostNetns.stdout.trim(), containerNetDev: fs.readFileSync('/proc/net/dev','utf8'), pidNs: namespaces.pid.self, root: require('child_process').execFileSync('stat', ['-Lc', '%d:%i', '/proc/1/root'], {encoding:'utf8'}).trim() }));
    })().catch(e => { console.error(e); process.exit(2); });
  `]);
}

function expectedFailure(args, scenario) {
  let output;
  try {
    output = run(["run", "--rm", "--label", label, ...args, tag, "node", "-e", `
      const { HostTelemetry } = require('./dist/services/HostTelemetry.js');
      new HostTelemetry().collect().then(value => process.stdout.write(JSON.stringify(value)));
    `]);
  } catch (error) {
    throw new Error(`${scenario}: probe process failed instead of reporting fail-closed result: ${error.stderr || error.message}`);
  }
  assert(output === "null", `${scenario}: expected null/no metrics, got ${output}`);
  evidence.cases[scenario] = { result: "fail-closed", observation: null };
}

try {
  run(["build", "--label", label, "--tag", tag, "."], { timeout: 600000 });
  imageBuilt = true;

  expectedFailure([], "isolated-pid-namespace");
  expectedFailure(["--privileged"], "privileged-isolated-pid-namespace");
  expectedFailure(["--pid=host"], "host-pid-without-privileges");

  const result = JSON.parse(dockerRun(["--pid=host", "--privileged"]));
  const observations = result.observations;
  assert(observations.length === 3 && observations.every(Boolean), "privileged host-PID probe did not return three observations");
  const latest = observations.at(-1);
  const prior = observations.at(-2);
  assert(latest.schema_version === 1 && latest.boot_id, "host observation is not canonical v1");
  assert(latest.collectors.memory.status === "success", "host memory collector did not succeed");
  assert(latest.collectors.disk.status === "success", "host disk collector did not succeed");
  assert(latest.collectors.disk.mounts.some(m => m.mount === "/" && m.size_bytes > 0), "host root filesystem was not reported");
  assert(latest.collectors.cpu.status === "success" || prior.collectors.cpu.status === "success", "CPU counters never produced a measured sample");
  assert(latest.collectors.network.status === "success" || prior.collectors.network.status === "success", "default-route network counters never produced a measured sample");
  assert(latest.collectors.memory.total_bytes <= Number.MAX_SAFE_INTEGER && latest.collectors.memory.used_bytes <= latest.collectors.memory.total_bytes, "host memory values exceed canonical bounds");
  assert(result.pidNs === run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "readlink", "/proc/1/ns/pid"]), "container process is not sharing host PID namespace");

  const hostRoot = run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "nsenter", "--target", "1", "--mount", "--root=/proc/1/root", "--wd=/", "--", "stat", "-Lc", "%d:%i", "/"]);
  assert(result.root === hostRoot, "producer root device/inode differs from nsenter host root");
  const hostMeminfo = run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "nsenter", "--target", "1", "--mount", "--root=/proc/1/root", "--wd=/", "--", "cat", "/proc/meminfo"]);
  const hostMemTotal = Number(hostMeminfo.match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]) * 1024;
  assert(latest.collectors.memory.total_bytes === hostMemTotal, "producer memory total differs from host /proc/meminfo");
  const hostMounts = JSON.parse(run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "nsenter", "--target", "1", "--mount", "--root=/proc/1/root", "--wd=/", "--", "/usr/bin/findmnt", "--json", "--bytes", "--df", "--target", "/", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"]));
  const referenceRoot = hostMounts.filesystems?.[0];
  const observedRoot = latest.collectors.disk.mounts.find(m => m.mount === "/");
  assert(referenceRoot && observedRoot.size_bytes === Number(referenceRoot.size), "producer root disk size differs from host findmnt");
  const hostRoutes = JSON.parse(run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "nsenter", "--target", "1", "--net", "--", "/sbin/ip", "-j", "route", "show", "default"]));
  const routeDevices = [...new Set(hostRoutes.flatMap(route => [route.dev, ...(route.nexthops || []).map(hop => hop.dev)].filter(Boolean)))];
  assert(routeDevices.length > 0, "host has no default-route network interface to validate");
  assert(result.namespaces.net.self !== result.namespaces.net.init, "test requires distinct container and host network namespaces");
  assert(result.hostNetns === result.namespaces.net.init, "nsenter child network namespace does not match host PID 1 network namespace");
  const netReads = result.calls.filter(c => c.file === "nsenter" && c.args.includes("/proc/net/dev"));
  const routeReads = result.calls.filter(c => c.file === "nsenter" && c.args.includes("route") && c.args.includes("default"));
  assert(netReads.length === observations.length, "producer did not read host /proc/net/dev exactly once per sample");
  assert(netReads.every(c => c.args.includes("--net") && c.args.includes("--root=/proc/1/root") && c.args.includes("/bin/cat")), "producer network counters were not read through host net namespace and root");
  assert(routeReads.length === observations.length * 2 && routeReads.every(c => c.args.includes("--net")), "producer did not read IPv4 and IPv6 default routes from host net namespace");
  const parseDev = text => new Map(text.split("\n").slice(2).flatMap(line => {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) return [];
    const fields = m[2].trim().split(/\s+/);
    return [[m[1].trim(), [BigInt(fields[0]), BigInt(fields[8])]]];
  }));
  const actualNetworkSnapshots = netReads.map(c => parseDev(c.stdout));
  const containerNetworkDevices = [...parseDev(result.containerNetDev).keys()].sort();
  const actualRouteSets = [];
  for (let i = 0; i < observations.length; i++) {
    const routePair = routeReads.slice(i * 2, i * 2 + 2);
    const devices = new Set(routePair.flatMap(c => JSON.parse(c.stdout).flatMap(route => [route.dev, ...(route.nexthops || []).map(hop => hop.dev)].filter(Boolean))));
    assert(devices.size > 0 && [...devices].every(device => actualNetworkSnapshots[i].has(device)), `sample ${i} host route NICs lack host counters`);
    actualRouteSets.push([...devices].sort());
    assert(JSON.stringify([...devices].sort()) === JSON.stringify(routeDevices.slice().sort()), `sample ${i} producer route NIC selection differs from independent host routes`);
    if (i === 0 || observations[i].collectors.network.status !== "success") continue;
    let rx = 0n; let tx = 0n;
    for (const device of devices) {
      const before = actualNetworkSnapshots[i - 1].get(device);
      const after = actualNetworkSnapshots[i].get(device);
      assert(before && after && after[0] >= before[0] && after[1] >= before[1], `sample ${i} host NIC counters did not form a non-reset interval`);
      rx += after[0] - before[0]; tx += after[1] - before[1];
    }
    assert(rx <= BigInt(Number.MAX_SAFE_INTEGER) && tx <= BigInt(Number.MAX_SAFE_INTEGER), "host network delta exceeds safe integer range");
    assert(observations[i].collectors.network.rx_bytes_delta === Number(rx) && observations[i].collectors.network.tx_bytes_delta === Number(tx), `sample ${i} producer network delta does not equal selected host NIC counter deltas`);
  }
  const hostCpuStat = run(["run", "--rm", "--pid=host", "--privileged", "--label", label, tag, "nsenter", "--target", "1", "--mount", "--root=/proc/1/root", "--wd=/", "--", "cat", "/proc/stat"]);
  const hostCoreCount = hostCpuStat.match(/^cpu\d+\s/mg)?.length ?? 0;
  const measuredCpu = [...observations].reverse().map(o => o.collectors.cpu).find(c => c.status === "success");
  assert(hostCoreCount > 0 && measuredCpu?.cores === hostCoreCount, "producer CPU core count differs from host /proc/stat");
  evidence.cases["privileged-host"] = {
    result: "pass",
    namespaces: result.namespaces,
    nsenter_network_namespace: result.hostNetns,
    container_network_devices: containerNetworkDevices,
    root_device_inode: result.root,
    host_default_route_devices: routeDevices,
    producer_route_devices_by_sample: actualRouteSets,
    memory_total_bytes: latest.collectors.memory.total_bytes,
    host_cpu_core_count: hostCoreCount,
    network_success_deltas: observations.map(o => o.collectors.network).filter(c => c.status === "success").map(({ rx_bytes_delta, tx_bytes_delta }) => ({ rx_bytes_delta, tx_bytes_delta })),
    root_mount: latest.collectors.disk.mounts.find(m => m.mount === "/"),
    cpu_statuses: observations.map(o => o.collectors.cpu.status),
    network_statuses: observations.map(o => o.collectors.network.status),
  };
  if (process.env.API_PROJECT_DIR) {
    execFileSync("php", [
      "scripts/api-parser-interop.php",
      process.env.API_PROJECT_DIR,
      "tests/fixtures/server-observations",
    ], {
      encoding: "utf8",
      stdio: "inherit",
      env: { ...process.env, PRODUCER_OBSERVATION_JSON: JSON.stringify(latest) },
    });
    evidence.cases["privileged-host"].api_parser = "passed with actual producer sample";
  }
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  if (imageBuilt) {
    try {
      const imageLabel = run(["image", "inspect", "--format", '{{index .Config.Labels "org.serversinc.test.run"}}', tag]);
      if (imageLabel === label.slice("org.serversinc.test.run=".length)) run(["image", "rm", tag]);
      else console.error(`Cleanup skipped: image ${tag} does not have this invocation's label.`);
    } catch (error) {
      console.error(`Cleanup failed for this invocation's image ${tag}: ${error.stderr || error.message}`);
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
    }
  }
}
