import { spawn } from "node:child_process";

export interface HostCommandResult { stdout: string; stderr: string }
export type HostCommand = (file: string, args: string[]) => Promise<HostCommandResult>;

/** Fixed-argv, bounded, read-only probes; never run through a shell. */
export function runHostProbe(file: string, args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<HostCommandResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    // A separate session gives this invocation its own process group, including
    // nsenter children. Killing just nsenter can leave the host probe running.
    const child = spawn(file, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let groupStopped = false;
    let exitFailure: (Error & { code: number | null; signal: string | null }) | undefined;
    const output = () => ({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    const stopGroup = (error: Error) => {
      // No graceful shutdown is needed for read-only probes. SIGKILL also
      // handles TERM-resistant commands, without an escalation timer that could
      // later target a reused process-group ID. Never signal a shared group.
      if (!groupStopped && child.pid !== undefined) {
        groupStopped = true;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") Object.assign(error, { cleanupError: killError });
        }
      }
    };
    const fail = (error: Error & { code?: string | number | null; signal?: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopGroup(error);
      // Do not wait for close: inherited pipes or uninterruptible kernel I/O
      // must not keep collection (or the agent's event loop) alive indefinitely.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(Object.assign(error, output()));
    };
    const timer = setTimeout(() => fail(exitFailure ?? Object.assign(new Error(`Host probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs);
    const collect = (chunk: Buffer, chunks: Buffer[], bytes: number): number => {
      if (settled) return bytes;
      const remaining = maxBuffer - bytes;
      chunks.push(chunk.subarray(0, Math.max(0, remaining)));
      if (chunk.length > remaining) fail(Object.assign(new Error("Host probe output exceeded maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      return bytes + Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = collect(chunk, stdout, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect(chunk, stderr, stderrBytes); });
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0) {
        exitFailure = Object.assign(new Error(`Host probe exited with ${signal ?? code}`), { code, signal });
        stopGroup(exitFailure);
        // Drain already-written diagnostics before rejecting on close, but
        // retain the deadline in case a descendant keeps its pipes open.
      }
    });
    child.on("close", () => {
      if (settled) return;
      if (exitFailure) { fail(exitFailure); return; }
      settled = true;
      clearTimeout(timer);
      resolve(output());
    });
  });
}
