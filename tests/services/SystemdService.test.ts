import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SystemdService,
  SystemdServiceError,
  isValidServiceUnit,
  MAX_JOURNAL_BYTES,
} from "../../src/services/SystemdService";
import * as HostShell from "../../src/services/HostShell";

vi.mock("../../src/services/HostShell", () => ({
  runHost: vi.fn(),
  runHostExec: vi.fn(),
  hostFileExists: vi.fn(),
  hostDirExists: vi.fn(),
  readHostFile: vi.fn(),
  writeHostFile: vi.fn(),
  hostCommand: vi.fn((cmd: string) => cmd),
}));

const mockRunHostExec = HostShell.runHostExec as unknown as ReturnType<typeof vi.fn>;
const mockHostDirExists = HostShell.hostDirExists as unknown as ReturnType<typeof vi.fn>;

const LIST_UNITS = [
  "● nginx.service loaded active running A high performance web server",
  "  postgresql.service loaded inactive dead PostgreSQL RDBMS",
  "  lone.service not-found inactive dead",
  "  not-a-service.timer loaded active waiting A timer",
].join("\n");

const LIST_UNIT_FILES = ["nginx.service enabled", "postgresql.service disabled", "static.service static"].join("\n");

describe("SystemdService", () => {
  let service: SystemdService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SystemdService();
  });

  describe("isValidServiceUnit", () => {
    it.each([
      "nginx.service",
      "example-agent.service",
      "postgresql@16-main.service",
      "a.service",
      "foo_bar.service",
    ])("accepts a valid unit name %j", unit => {
      expect(isValidServiceUnit(unit)).toBe(true);
    });

    it.each([
      "",
      "nginx",
      "nginx.timer",
      "nginx.socket",
      "-n.service",
      "--now",
      "../../etc/passwd",
      "nginx.service; rm -rf /",
      "nginx.service && systemctl stop foo",
      "nginx service.service",
      "nginx.service\nfoo",
      "a".repeat(256) + ".service",
    ])("rejects an invalid unit name %j", unit => {
      expect(isValidServiceUnit(unit)).toBe(false);
    });
  });

  describe("listServices", () => {
    it("parses units and merges boot enablement from the unit-file list", () => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockReturnValueOnce(LIST_UNITS).mockReturnValueOnce(LIST_UNIT_FILES);

      const result = service.listServices();

      expect(result.systemd_available).toBe(true);
      expect(result.services).toEqual([
        {
          name: "nginx.service",
          unit: "nginx.service",
          description: "A high performance web server",
          load_state: "loaded",
          active_state: "active",
          sub_state: "running",
          enabled_state: "enabled",
          enabled: true,
        },
        {
          name: "postgresql.service",
          unit: "postgresql.service",
          description: "PostgreSQL RDBMS",
          load_state: "loaded",
          active_state: "inactive",
          sub_state: "dead",
          enabled_state: "disabled",
          enabled: false,
        },
        {
          name: "lone.service",
          unit: "lone.service",
          description: "",
          load_state: "not-found",
          active_state: "inactive",
          sub_state: "dead",
          enabled_state: "unknown",
          enabled: false,
        },
      ]);
    });

    it("uses fixed systemctl argv with no shell for both listing calls", () => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockReturnValueOnce(LIST_UNITS).mockReturnValueOnce(LIST_UNIT_FILES);

      service.listServices();

      expect(mockRunHostExec).toHaveBeenNthCalledWith(
        1,
        "systemctl",
        ["list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(mockRunHostExec).toHaveBeenNthCalledWith(
        2,
        "systemctl",
        ["list-unit-files", "--type=service", "--no-pager", "--plain", "--no-legend"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it("returns 501 when systemd is absent", () => {
      mockHostDirExists.mockReturnValue(false);

      expect(() => service.listServices()).toThrow(SystemdServiceError);
      try { service.listServices(); } catch (err) { expect((err as SystemdServiceError).statusCode).toBe(501); }
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it("throws a 500 SystemdServiceError when the unit list command fails", () => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), { stderr: "System has not been booted with systemd" });
      });

      try {
        service.listServices();
        throw new Error("expected listServices to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SystemdServiceError);
        expect((err as SystemdServiceError).statusCode).toBe(500);
        expect((err as Error).message).toMatch(/System has not been booted with systemd/);
      }
    });

    it("still returns the unit list when the unit-file list command fails", () => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockReturnValueOnce(LIST_UNITS).mockImplementationOnce(() => {
        throw new Error("list-unit-files unavailable");
      });

      const result = service.listServices();

      expect(result.services[0].enabled_state).toBe("unknown");
      expect(result.services[0].enabled).toBe(false);
    });
  });

  describe("performAction", () => {
    beforeEach(() => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockReturnValue("");
    });

    it("runs start as systemctl start <unit>", () => {
      const result = service.performAction("nginx.service", "start");

      expect(mockRunHostExec).toHaveBeenCalledWith(
        "systemctl",
        ["start", "nginx.service"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(result).toEqual({ unit: "nginx.service", action: "start", success: true, exit_code: 0, output: "", error: "" });
    });

    it("enables at boot without --now so it does not also change running state", () => {
      service.performAction("nginx.service", "enable");

      const [, args] = mockRunHostExec.mock.calls[0];
      expect(args).toEqual(["enable", "nginx.service"]);
      expect(args).not.toContain("--now");
    });

    it("disables at boot without --now so it does not also change running state", () => {
      service.performAction("nginx.service", "disable");

      const [, args] = mockRunHostExec.mock.calls[0];
      expect(args).toEqual(["disable", "nginx.service"]);
      expect(args).not.toContain("--now");
    });

    it.each([
      "../../etc/passwd",
      "nginx.service; rm -rf /",
      "nginx.service && systemctl stop docker",
      "-n",
      "nginx",
    ])("rejects invalid unit %j without running anything", unit => {
      expect(() => service.performAction(unit, "start")).toThrow(/Invalid unit name/);
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it("rejects an action outside the allowlist without running anything", () => {
      expect(() => service.performAction("nginx.service", "mask" as any)).toThrow(/Unsupported action/);
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it("throws a 501 when systemd is not available", () => {
      mockHostDirExists.mockReturnValue(false);

      try {
        service.performAction("nginx.service", "start");
        throw new Error("expected performAction to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SystemdServiceError);
        expect((err as SystemdServiceError).statusCode).toBe(501);
        expect((err as Error).message).toMatch(/systemd is not available/);
      }
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it("maps a missing unit to a 404", () => {
      mockRunHostExec.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), { stderr: "Failed to start nginx.service: Unit nginx.service not found.", status: 5 });
      });

      try {
        service.performAction("nginx.service", "start");
        throw new Error("expected performAction to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SystemdServiceError);
        expect((err as SystemdServiceError).statusCode).toBe(404);
        expect((err as Error).message).toMatch(/Unit not found: nginx.service/);
      }
    });

    it("returns a failed operation result when systemctl reports a job failure", () => {
      mockRunHostExec.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stdout: "",
          stderr: "Job for nginx.service failed because the control process exited with error code.",
          status: 1,
        });
      });

      const result = service.performAction("nginx.service", "restart");

      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(1);
      expect(result.error).toMatch(/Job for nginx.service failed/);
    });
  });

  describe("getJournal", () => {
    beforeEach(() => {
      mockHostDirExists.mockReturnValue(true);
      mockRunHostExec.mockReturnValue("Jan 01 00:00:00 host nginx[1]: started");
    });

    it("builds a fixed journalctl argv with bounded lines and a validated since", () => {
      mockRunHostExec.mockReturnValueOnce("loaded").mockReturnValueOnce("Jan 01 00:00:00 host nginx[1]: started");
      const result = service.getJournal("nginx.service", 50, "2h");

      expect(mockRunHostExec).toHaveBeenCalledWith(
        "systemctl", ["show", "nginx.service", "--property=LoadState", "--value"], expect.anything(),
      );
      expect(mockRunHostExec).toHaveBeenCalledWith(
        "journalctl",
        ["--unit", "nginx.service", "--no-pager", "--output", "short-iso", "--lines", "50", "--since", "2h"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(result).toEqual({
        unit: "nginx.service",
        lines: ["Jan 01 00:00:00 host nginx[1]: started"],
        since: "2h",
        output: "Jan 01 00:00:00 host nginx[1]: started",
        truncated: false,
      });
    });

    it("defaults to 100 lines over the last hour", () => {
      mockRunHostExec.mockReturnValueOnce("loaded").mockReturnValueOnce("entry");
      const result = service.getJournal("nginx.service");

      expect(result.lines).toEqual(["entry"]);
      expect(result.since).toBe("1h");
      expect(mockRunHostExec).toHaveBeenCalledWith(
        "journalctl",
        expect.arrayContaining(["--lines", "100", "--since", "1h"]),
        expect.anything(),
      );
    });

    it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid line counts (%j) without running anything", lines => {
      expect(() => service.getJournal("nginx.service", lines as number, "1h")).toThrow(/Invalid line count/);
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it.each(["-1h", "1h; rm -rf /", "now --foo", "nonsense", "1h && id", "", "2024-02-30", "2024-13-01", "2024-01-01T25:00"])(
      "rejects invalid since %j without running anything",
      since => {
        expect(() => service.getJournal("nginx.service", 10, since)).toThrow(/Invalid since value/);
        expect(mockRunHostExec).not.toHaveBeenCalled();
      },
    );

    it("truncates output that exceeds the byte cap", () => {
      mockRunHostExec.mockReturnValueOnce("loaded").mockReturnValueOnce("a".repeat(MAX_JOURNAL_BYTES + 500));

      const result = service.getJournal("nginx.service", 1000, "1h");

      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MAX_JOURNAL_BYTES);
    });

    it("throws a 503 when systemd is not available", () => {
      mockHostDirExists.mockReturnValue(false);

      expect(() => service.getJournal("nginx.service", 10, "1h")).toThrow(SystemdServiceError);
      expect(mockRunHostExec).not.toHaveBeenCalled();
    });

    it("returns 404 when systemctl reports the unit is absent, even if journalctl would be empty", () => {
      mockRunHostExec.mockReturnValueOnce("not-found");
      expect(() => service.getJournal("missing.service", 10, "1h")).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
      expect(mockRunHostExec).toHaveBeenCalledTimes(1);
    });
  });
});
