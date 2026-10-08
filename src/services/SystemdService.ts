import { runHostExec, hostDirExists } from "./HostShell";

export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";

export interface SystemdServiceUnit {
  /** The systemd unit name, e.g. "nginx.service". */
  name: string;
  /** Alias of `name`; the unit the row describes. */
  unit: string;
  description: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  /** Raw `systemctl` unit-file state: enabled, disabled, static, masked, ... */
  enabled_state: string;
  /** True only for `enabled` / `enabled-runtime`, i.e. starts at boot. */
  enabled: boolean;
}

export interface SystemdActionResponse {
  unit: string;
  action: ServiceAction;
  success: boolean;
  exit_code: number;
  output: string;
  error: string;
}

export interface SystemdJournalResponse {
  unit: string;
  lines: string[];
  since: string;
  output: string;
  truncated: boolean;
}

export class SystemdServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "SystemdServiceError";
  }
}

/** Canonical systemd-as-PID-1 marker; absent in containers/chroots without systemd. */
const SYSTEMD_RUNTIME_DIR = "/run/systemd/system";

/**
 * A systemd service unit name. Deliberately strict: a leading alphanumeric
 * keeps the value from being mistaken for a `systemctl` option, and the
 * character class excludes whitespace, quotes, path separators and every
 * shell metacharacter. Only `.service` units are accepted because that is all
 * the Services tab lists and acts on.
 */
const SERVICE_UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;

const MAX_UNIT_NAME_LENGTH = 255;

/**
 * A journalctl `--since` value. Accepts relative spans ("1h", "30 min",
 * "2 days ago"), the "now"/"today"/"yesterday" keywords, and plain ISO dates
 * or timestamps. Deliberately rejects anything starting with "-" so the value
 * can never be read as a journalctl option.
 */
export const SINCE_PATTERN =
  /^(?:now|today|yesterday|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)(?:\s+ago)?)$/i;

export const DEFAULT_JOURNAL_LINES = 100;
export const MAX_JOURNAL_LINES = 1000;
export const DEFAULT_JOURNAL_SINCE = "1h";
export const MAX_JOURNAL_BYTES = 256 * 1024;

const MAX_ACTION_OUTPUT_BYTES = 64 * 1024;

const LIST_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 30_000;
const JOURNAL_TIMEOUT_MS = 10_000;

const ALLOWED_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart", "enable", "disable"];

export function isValidServiceUnit(unit: unknown): unit is string {
  return (
    typeof unit === "string" &&
    unit.length > 0 &&
    unit.length <= MAX_UNIT_NAME_LENGTH &&
    SERVICE_UNIT_PATTERN.test(unit)
  );
}

export function isValidServiceAction(action: unknown): action is ServiceAction {
  return typeof action === "string" && (ALLOWED_ACTIONS as readonly string[]).includes(action);
}

export function isValidSince(since: unknown): since is string {
  if (typeof since !== "string" || !SINCE_PATTERN.test(since)) return false;
  const date = since.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!date) return true;
  const [, y, m, d, h, min, sec] = date;
  const year = Number(y), month = Number(m), day = Number(d);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  return h === undefined || (Number(h) <= 23 && Number(min) <= 59 && (sec === undefined || Number(sec) <= 59));
}

export function isValidJournalLines(lines: unknown): lines is number {
  return typeof lines === "number" && Number.isInteger(lines) && lines >= 1 && lines <= MAX_JOURNAL_LINES;
}

interface ExecErrorLike {
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
  status?: number | null;
  code?: number | string | null;
  message?: string;
}

function toText(value: Buffer | string | null | undefined): string {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value).trim();
}

function errorStderr(err: unknown): string {
  return toText((err as ExecErrorLike)?.stderr);
}

function errorStdout(err: unknown): string {
  return toText((err as ExecErrorLike)?.stdout);
}

function errorExitCode(err: unknown): number {
  const status = (err as ExecErrorLike)?.status;
  if (typeof status === "number") return status;
  const code = (err as ExecErrorLike)?.code;
  if (typeof code === "number") return code;
  return 1;
}

function errorMessage(err: unknown): string {
  return errorStderr(err) || (err as Error)?.message || String(err);
}

/** systemctl's wording when the requested unit is not present on the host. */
function isMissingUnitError(message: string): boolean {
  return /not found|does not exist|no such unit|not loaded|bad unit/i.test(message);
}

function truncateOutput(output: string, maxBytes: number): { output: string; truncated: boolean } {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.length <= maxBytes) {
    return { output, truncated: false };
  }
  // Slice on a byte boundary, then drop a trailing replacement char if the cut
  // landed mid-codepoint.
  const sliced = buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
  return { output: sliced, truncated: true };
}

function parseUnitFiles(output: string): Map<string, string> {
  const enabledByUnit = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const parts = rawLine.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [unit, state] = parts;
    if (!unit.endsWith(".service")) continue;
    enabledByUnit.set(unit, state);
  }
  return enabledByUnit;
}

function parseUnits(output: string, enabledByUnit: Map<string, string>): SystemdServiceUnit[] {
  const services: SystemdServiceUnit[] = [];
  for (const rawLine of output.split("\n")) {
    const parts = rawLine.trim().split(/\s+/).filter(Boolean);
    // `--plain` should omit the status bullet, but tolerate it on older systemd.
    while (parts.length > 0 && (parts[0] === "●" || parts[0] === "*")) parts.shift();
    if (parts.length < 4) continue;

    const [unit, loadState, activeState, subState] = parts;
    if (!unit.endsWith(".service")) continue;

    const enabledState = enabledByUnit.get(unit) ?? "unknown";
    services.push({
      name: unit,
      unit,
      description: parts.slice(4).join(" "),
      load_state: loadState,
      active_state: activeState,
      sub_state: subState,
      enabled_state: enabledState,
      enabled: enabledState === "enabled" || enabledState === "enabled-runtime",
    });
  }
  return services;
}

/**
 * Systemd operations against the host. Every command is a fixed binary plus an
 * allowlisted verb and a strictly validated unit name, run through
 * {@link runHostExec} with no shell, so no caller input is ever interpreted as
 * a shell fragment or a systemctl option.
 */
export class SystemdService {
  public readonly name = "Systemd";

  isSystemdAvailable(): boolean {
    return hostDirExists(SYSTEMD_RUNTIME_DIR);
  }

  listServices(): { systemd_available: true; services: SystemdServiceUnit[] } {
    if (!this.isSystemdAvailable()) {
      throw new SystemdServiceError("systemd is not available on this host", 501);
    }

    let unitsOutput: string;
    try {
      unitsOutput = runHostExec(
        "systemctl",
        ["list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"],
        { timeout: LIST_TIMEOUT_MS },
      );
    } catch (err) {
      throw new SystemdServiceError(`Failed to list systemd services: ${errorMessage(err)}`, 500);
    }

    // Boot enablement lives in the unit files, not in `list-units` output.
    // Best-effort: a host without list-unit-files still gets the running list.
    let enabledByUnit = new Map<string, string>();
    try {
      const unitFilesOutput = runHostExec(
        "systemctl",
        ["list-unit-files", "--type=service", "--no-pager", "--plain", "--no-legend"],
        { timeout: LIST_TIMEOUT_MS },
      );
      enabledByUnit = parseUnitFiles(unitFilesOutput);
    } catch {
      enabledByUnit = new Map<string, string>();
    }

    return { systemd_available: true, services: parseUnits(unitsOutput, enabledByUnit) };
  }

  performAction(unit: string, action: ServiceAction): SystemdActionResponse {
    if (!isValidServiceUnit(unit)) {
      throw new SystemdServiceError(`Invalid unit name: ${String(unit)}`, 400);
    }
    if (!isValidServiceAction(action)) {
      throw new SystemdServiceError(`Unsupported action: ${String(action)}`, 400);
    }
    if (!this.isSystemdAvailable()) {
      throw new SystemdServiceError("systemd is not available on this host", 501);
    }

    // enable/disable only change boot enablement. `--now` is deliberately never
    // passed so enabling a stopped unit does not also start it (and vice versa).
    const args = [action, unit];

    try {
      const output = runHostExec("systemctl", args, { timeout: ACTION_TIMEOUT_MS });
      return {
        unit,
        action,
        success: true,
        exit_code: 0,
        output: truncateOutput(output, MAX_ACTION_OUTPUT_BYTES).output,
        error: "",
      };
    } catch (err) {
      const message = errorMessage(err);
      if (isMissingUnitError(message)) {
        throw new SystemdServiceError(`Unit not found: ${unit}`, 404);
      }
      return {
        unit,
        action,
        success: false,
        exit_code: errorExitCode(err),
        output: truncateOutput(errorStdout(err), MAX_ACTION_OUTPUT_BYTES).output,
        error: truncateOutput(message, MAX_ACTION_OUTPUT_BYTES).output,
      };
    }
  }

  getJournal(unit: string, lines: number = DEFAULT_JOURNAL_LINES, since: string = DEFAULT_JOURNAL_SINCE): SystemdJournalResponse {
    if (!isValidServiceUnit(unit)) {
      throw new SystemdServiceError(`Invalid unit name: ${String(unit)}`, 400);
    }
    if (!isValidJournalLines(lines)) {
      throw new SystemdServiceError(`Invalid line count: ${String(lines)}`, 400);
    }
    if (!isValidSince(since)) {
      throw new SystemdServiceError(`Invalid since value: ${String(since)}`, 400);
    }
    if (!this.isSystemdAvailable()) {
      throw new SystemdServiceError("systemd is not available on this host", 501);
    }

    // journalctl may return success and no rows for an unknown unit. Check its
    // load state first so callers receive an explicit not-found response.
    let unitState: string;
    try {
      unitState = runHostExec("systemctl", ["show", unit, "--property=LoadState", "--value"], { timeout: LIST_TIMEOUT_MS }).trim();
    } catch (err) {
      const message = errorMessage(err);
      if (isMissingUnitError(message)) throw new SystemdServiceError(`Unit not found: ${unit}`, 404);
      throw new SystemdServiceError(`Failed to inspect systemd unit: ${message}`, 500);
    }
    if (unitState === "not-found" || unitState === "") throw new SystemdServiceError(`Unit not found: ${unit}`, 404);

    const output = runHostExec(
      "journalctl",
      ["--unit", unit, "--no-pager", "--output", "short-iso", "--lines", String(lines), "--since", since],
      { timeout: JOURNAL_TIMEOUT_MS },
    );
    const bounded = truncateOutput(output, MAX_JOURNAL_BYTES);

    return { unit, lines: bounded.output === "" ? [] : bounded.output.split("\n"), since, output: bounded.output, truncated: bounded.truncated };
  }
}

export const systemdService = new SystemdService();
