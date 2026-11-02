import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runHostProbe } from "../../src/services/HostProbeCommand.js";

// Both processes expire independently even if cleanup regresses. The child
// inherits the probe's group and pipes, and deliberately ignores SIGTERM.
const fixture = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', \
    "process.on('SIGTERM', () => {}); console.log(process.pid); setTimeout(() => process.exit(0), 6000);"\
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', data => {
    console.log(JSON.stringify({ parent: process.pid, child: Number(data.toString().trim()) }));
    if (process.argv[1] === 'buffer') process.stdout.write('x'.repeat(8192));
    if (process.argv[1] === 'stderr-buffer') process.stderr.write('x'.repeat(8192));
    if (process.argv[1] === 'exit') process.exit(9);
  });
  setTimeout(() => process.exit(0), 6000);
`;

async function running(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // An orphan zombie is already terminated; only its init reaper can remove
    // the record. In particular, kill(pid, 0) alone cannot prove it is alive.
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("host probe subprocess runner", () => {
  it("preserves argv literally and forces a C locale", async () => {
    const literal = "$(echo must-not-run); * ' \"";
    const result = await runHostProbe(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.argv[1], process.env.LC_ALL, process.env.LANG])); process.stderr.write('diagnostic');", literal]);
    expect(JSON.parse(result.stdout)).toEqual([literal, "C", "C"]);
    expect(result.stderr).toBe("diagnostic");
  });

  it("preserves ENOENT for unsupported-command classification", async () => {
    await expect(runHostProbe("/serversinc-nonexistent-host-probe", [])).rejects.toMatchObject({ code: "ENOENT", stdout: "", stderr: "" });
  });

  it("preserves nonzero exit status and stderr", async () => {
    await expect(runHostProbe(process.execPath, ["-e", "process.stderr.write('No such file or directory'); process.exitCode = 127;"])).rejects.toMatchObject({ code: 127, stderr: "No such file or directory" });
  });

  it("enforces the production 2 MiB output bound", async () => {
    const error = await runHostProbe(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));"]).catch(error => error);
    expect(error.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(Buffer.byteLength(error.stdout)).toBe(2 * 1024 * 1024);
  });

  it.runIf(process.platform === "linux").each([
    ["timeout", "ETIMEDOUT"],
    ["buffer", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"],
    ["stderr-buffer", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"],
    ["exit", 9],
  ])("terminates a TERM-resistant process tree after %s", async (mode, code) => {
    const start = Date.now();
    const error = await runHostProbe(process.execPath, ["-e", fixture, mode], { timeoutMs: 800, maxBuffer: 1024 }).catch(error => error);
    expect(error.code).toBe(code);
    expect(Date.now() - start).toBeLessThan(2500);
    const pids = JSON.parse(error.stdout.split("\n")[0]);
    expect(pids.parent).toBeGreaterThan(0);
    expect(pids.child).toBeGreaterThan(0);
    await expect.poll(async () => Promise.all([running(pids.parent), running(pids.child)]), { timeout: 1500 }).toEqual([false, false]);
    expect(Buffer.byteLength(error.stdout)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(1024);
  });
});
