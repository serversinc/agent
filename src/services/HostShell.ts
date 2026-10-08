import { execSync, execFileSync } from "child_process";

/**
 * The agent runs as a container (Alpine base) but ufw/sshd/fail2ban/apt are
 * host-level concerns with nothing containerized about them — none of that
 * tooling or filesystem exists inside the container's own namespace. Every
 * command here crosses into the host's mount/uts/ipc/net/pid namespaces via
 * nsenter against PID 1, which requires the container to run `--pid=host`
 * with CAP_SYS_ADMIN (in practice `--privileged`) as root — a non-root
 * container user cannot open /proc/1/ns/* even with capabilities granted.
 */
const NSENTER = "nsenter -t 1 -m -u -i -n -p --";
const NSENTER_ARGS = ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

export function runHost(cmd: string): string {
  return execSync(`${NSENTER} ${cmd}`, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Run a host binary with a fixed argv and no shell, the way `runHost` reaches
 * the host but without ever concatenating a command string. Because every
 * argument crosses as a discrete argv entry there is no place for shell
 * metacharacters to be interpreted, and stderr is captured so callers can
 * surface why a command failed (execFileSync exposes it on the thrown error).
 * Used by SystemdService, whose arguments include user-supplied unit names.
 */
export function runHostExec(binary: string, args: string[] = [], options: { timeout?: number } = {}): string {
  return execFileSync("nsenter", [...NSENTER_ARGS, binary, ...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function hostFileExists(path: string): boolean {
  try {
    execSync(`${NSENTER} test -f '${path}'`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hostDirExists(path: string): boolean {
  try {
    execSync(`${NSENTER} test -d '${path}'`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function readHostFile(path: string): string {
  return execSync(`${NSENTER} cat '${path}'`, { encoding: "utf8", timeout: 5000 });
}

/**
 * Content travels base64-encoded over the nsenter'd shell command so
 * arbitrary file content (config directives, multi-line files) never has to
 * be shell-escaped.
 */
export function writeHostFile(path: string, content: string): void {
  const base64 = Buffer.from(content, "utf8").toString("base64");
  execSync(`${NSENTER} sh -c "echo ${base64} | base64 -d > '${path}'"`, { timeout: 5000 });
}

export function hostCommand(cmd: string): string {
  return `${NSENTER} ${cmd}`;
}
