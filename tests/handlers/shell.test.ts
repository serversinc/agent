import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createShellHandlers } from "../../src/controllers/shell";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";
import { makeDockerMuxedBuffer } from "../helpers/streams";
import { ShellService } from "../../src/services/Shell";

vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Shell Handlers — execContainer", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let mockShellService: ShellService;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    mockShellService = new ShellService();
    const handlers = createShellHandlers(mockShellService, mockDockerService);
    const s = await makeApp(
      app => {
        app.post("/exec-container", handlers.execContainer);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  it("runs the command via dockerode exec, not a shelled-out docker CLI", async () => {
    const buf = makeDockerMuxedBuffer("accepting connections\n", "");
    const mockExec = {
      start: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield buf;
        },
      }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "pg_isready -U postgres" });

    expect(response.status).toBe(200);
    expect(response.body.output).toBe("accepting connections");
    expect(response.body.exit_code).toBe(0);
    expect(mockDockerService.docker.getContainer).toHaveBeenCalledWith("postgres-16");
    expect(mockContainer.exec).toHaveBeenCalledWith({
      Cmd: ["sh", "-c", "pg_isready -U postgres"],
      AttachStdout: true,
      AttachStderr: true,
    });
  });

  it("returns a non-zero exit code without treating it as a request error", async () => {
    const buf = makeDockerMuxedBuffer("", "not ready\n");
    const mockExec = {
      start: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield buf;
        },
      }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 1 }),
    };
    const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "pg_isready -U postgres" });

    expect(response.status).toBe(200);
    expect(response.body.exit_code).toBe(1);
    expect(response.body.error).toBe("not ready");
  });

  it("rejects unsafe container names", async () => {
    const response = await request(server)
      .post("/exec-container")
      .send({ container: "../etc/passwd", command: "ls" });

    expect(response.status).toBe(400);
  });

  it("handles exec errors", async () => {
    const mockContainer = { exec: vi.fn().mockRejectedValue(new Error("Container not found")) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "ls" });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Container not found");
  });
});
