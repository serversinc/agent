import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { zValidator } from "@hono/zod-validator";
import { createContainerHandlers } from "../../src/controllers/containers";
import { containerLogsQuerySchema } from "../../src/validators/Containers";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";
import { makeDockerMuxedBuffer } from "../helpers/streams";

// Async iterable over a fixed list of chunks — stands in for the finite tail of a mocked
// docker log stream. Real streams don't end this cleanly, but the test harness buffers the
// full SSE response body, so the mock stream has to terminate for a request to resolve.
function fakeLogStream(chunks: Buffer[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

// Mock DockerService; silence console in this test file only
vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Container Handlers", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    // Create mock Docker service
    mockDockerService = createDockerMock();

    const handlers = createContainerHandlers(mockDockerService);

    const s = await makeApp(
      app => {
        app.get("/containers", handlers.list);
        app.get("/containers/:id", handlers.get);
        app.post("/containers", handlers.create);
        app.delete("/containers/:id", handlers.remove);
        app.post("/containers/:id/restart", handlers.restart);
        app.post("/containers/:id/start", handlers.start);
        app.post("/containers/:id/stop", handlers.stop);
        app.post("/containers/:id/exec", handlers.runCommand);
        app.get("/containers/:id/logs", zValidator("query", containerLogsQuerySchema), handlers.logs);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  describe("GET /containers", () => {
    it("should return list of containers", async () => {
      mockDockerService.listContainers.mockResolvedValue([{ id: "123", name: "test-container" }]);

      const response = await request(server).get("/containers");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ id: "123", name: "test-container" }]);
      expect(mockDockerService.listContainers).toHaveBeenCalledTimes(1);
    });

    it("should handle errors", async () => {
      mockDockerService.listContainers.mockRejectedValue(new Error("Docker daemon not running"));

      const response = await request(server).get("/containers");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Docker daemon not running");
    });
  });

  describe("POST /containers", () => {
    it("should create a container", async () => {
      mockDockerService.checkImageExists.mockResolvedValue(true);
      mockDockerService.createContainer.mockResolvedValue({
        id: "new-123",
      });
      mockDockerService.getContainer.mockResolvedValue({
        Id: "new-123",
        Name: "/test-container",
      });

      const response = await request(server).post("/containers").send({
        name: "test-container",
        image: "nginx:latest",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.container.Id).toBe("new-123");
    });

    it("should pull image when missing and use auth", async () => {
      // image not present
      mockDockerService.checkImageExists.mockResolvedValue(false);

      mockDockerService.createContainer.mockResolvedValue({ id: "new-456" });
      mockDockerService.getContainer.mockResolvedValue({ Id: "new-456", Name: "/pulled" });

      const response = await request(server)
        .post("/containers")
        .send({
          name: "pulled-container",
          image: "private:1.0",
          pullImage: false,
          auth: { username: "u", password: "p", registry: "r" },
        });

      expect(response.status).toBe(200);
      expect(mockDockerService.pullImage).toHaveBeenCalledWith("private:1.0", {
        username: "u",
        password: "p",
        registry: "r",
      });
      expect(response.body.container.Id).toBe("new-456");
    });

    it("should start container when start=true", async () => {
      mockDockerService.checkImageExists.mockResolvedValue(true);
      mockDockerService.createContainer.mockResolvedValue({ id: "new-789" });
      mockDockerService.getContainer.mockResolvedValue({ Id: "new-789", Name: "/started" });

      const response = await request(server).post("/containers").send({
        name: "started-container",
        image: "nginx:alpine",
        start: true,
      });

      expect(response.status).toBe(200);
      expect(mockDockerService.startContainer).toHaveBeenCalledWith("new-789");
      expect(response.body.container.Id).toBe("new-789");
    });

    it("should handle create errors", async () => {
      mockDockerService.checkImageExists.mockRejectedValue(new Error("Image not found"));

      const response = await request(server).post("/containers").send({
        name: "test-container",
        image: "nonexistent:latest",
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Image not found");
    });
  });

  describe("GET /containers/:id", () => {
    it("should return a container by id", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Name: "/my-container" });

      const response = await request(server).get("/containers/abc123");

      expect(response.status).toBe(200);
      expect(response.body.Id).toBe("abc123");
      expect(mockDockerService.getContainer).toHaveBeenCalledWith("abc123");
    });

    it("should return 404 for non-existent container", async () => {
      mockDockerService.getContainer.mockRejectedValue(new Error("Container not found"));

      const response = await request(server).get("/containers/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Container not found");
    });
  });

  describe("DELETE /containers/:id", () => {
    it("should remove a container", async () => {
      mockDockerService.removeContainer.mockResolvedValue(undefined);

      const response = await request(server).delete("/containers/abc123");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.id).toBe("abc123");
      expect(mockDockerService.removeContainer).toHaveBeenCalledWith("abc123");
    });

    it("should handle remove errors", async () => {
      mockDockerService.removeContainer.mockRejectedValue(new Error("Container is running"));

      const response = await request(server).delete("/containers/abc123");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Container is running");
    });
  });

  describe("POST /containers/:id/restart", () => {
    it("should restart a container", async () => {
      mockDockerService.restartContainer.mockResolvedValue(undefined);

      const response = await request(server).post("/containers/abc123/restart");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.id).toBe("abc123");
      expect(mockDockerService.restartContainer).toHaveBeenCalledWith("abc123");
    });

    it("should handle restart errors", async () => {
      mockDockerService.restartContainer.mockRejectedValue(new Error("Container not running"));

      const response = await request(server).post("/containers/abc123/restart");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Container not running");
    });
  });

  describe("POST /containers/:id/start", () => {
    it("should start a container", async () => {
      mockDockerService.startContainer.mockResolvedValue(undefined);

      const response = await request(server).post("/containers/abc123/start");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.id).toBe("abc123");
      expect(mockDockerService.startContainer).toHaveBeenCalledWith("abc123");
    });

    it("should handle start errors", async () => {
      mockDockerService.startContainer.mockRejectedValue(new Error("Container already started"));

      const response = await request(server).post("/containers/abc123/start");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Container already started");
    });
  });

  describe("POST /containers/:id/stop", () => {
    it("should stop a container", async () => {
      mockDockerService.stopContainer.mockResolvedValue(undefined);

      const response = await request(server).post("/containers/abc123/stop");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.id).toBe("abc123");
      expect(mockDockerService.stopContainer).toHaveBeenCalledWith("abc123");
    });

    it("should handle stop errors", async () => {
      mockDockerService.stopContainer.mockRejectedValue(new Error("Container not running"));

      const response = await request(server).post("/containers/abc123/stop");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Container not running");
    });

    it("should pass through a timeout from the request body", async () => {
      mockDockerService.stopContainer.mockResolvedValue(undefined);

      const response = await request(server).post("/containers/abc123/stop").send({ timeout: 140 });

      expect(response.status).toBe(200);
      expect(mockDockerService.stopContainer).toHaveBeenCalledWith("abc123", 140);
    });
  });

  describe("POST /containers/:id/exec", () => {
    it("should execute a command in a container", async () => {
      const mockExec = {
        start: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            // no output
          },
        }),
      };
      const mockContainer = {
        exec: vi.fn().mockResolvedValue(mockExec),
      };
      mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

      const response = await request(server).post("/containers/abc123/exec").send({ command: "echo hello" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockContainer.exec).toHaveBeenCalled();
    });

    it("should demultiplex stdout/stderr and strip ANSI when command is a string", async () => {
      const buf = makeDockerMuxedBuffer("\u001b[31mhello\u001b[0m\n", "err\n");

      const mockExec = {
        start: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield buf;
          },
        }),
      };
      const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
      mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

      const response = await request(server).post("/containers/abc123/exec").send({ command: 'echo "hello"' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.output.stdout).toBe("hello");
      expect(response.body.output.stderr).toBe("err");
    });

    it("should accept command as array and return joined command string", async () => {
      const buf = makeDockerMuxedBuffer("out\n", "");

      const mockExec = {
        start: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield buf;
          },
        }),
      };
      const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
      mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

      const response = await request(server)
        .post("/containers/abc123/exec")
        .send({ command: ["echo", "hello"] });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.command).toBe("echo hello");
      expect(response.body.output.stdout).toBe("out");
    });

    it("should handle exec errors", async () => {
      const mockContainer = {
        exec: vi.fn().mockRejectedValue(new Error("Container not found")),
      };
      mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

      const response = await request(server).post("/containers/abc123/exec").send({ command: "ls" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Container not found");
    });
  });

  describe("GET /containers/:id/logs", () => {
    it("returns demuxed one-shot logs for a non-tty container, in order", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.getContainerLogs.mockResolvedValue(makeDockerMuxedBuffer("out\n", "err\n"));

      const response = await request(server).get("/containers/abc123/logs");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        id: "abc123",
        logs: [
          { stream: "stdout", message: "out\n" },
          { stream: "stderr", message: "err\n" },
        ],
      });
    });

    it("returns raw output for a tty container instead of demuxing", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: true } });
      mockDockerService.getContainerLogs.mockResolvedValue(Buffer.from("raw tty output\n", "utf8"));

      const response = await request(server).get("/containers/abc123/logs");

      expect(response.status).toBe(200);
      expect(response.body.logs).toEqual([{ stream: "stdout", message: "raw tty output\n" }]);
    });

    it("defaults tail/stdout/stderr and passes query params through to the service", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.getContainerLogs.mockResolvedValue(Buffer.alloc(0));

      await request(server).get("/containers/abc123/logs").query({ tail: "50", since: "100", timestamps: "true", stdout: "false" });

      expect(mockDockerService.getContainerLogs).toHaveBeenCalledWith("abc123", {
        tail: 50,
        since: 100,
        timestamps: true,
        stdout: false,
        stderr: true,
      });
    });

    it("rejects a non-numeric tail with 400 instead of falling through to Docker", async () => {
      const response = await request(server).get("/containers/abc123/logs").query({ tail: "abc" });

      expect(response.status).toBe(400);
      expect(mockDockerService.getContainerLogs).not.toHaveBeenCalled();
    });

    it("rejects a tail above the cap with 400", async () => {
      const response = await request(server).get("/containers/abc123/logs").query({ tail: "999999" });

      expect(response.status).toBe(400);
    });

    it("rejects an unrecognized follow value with 400", async () => {
      const response = await request(server).get("/containers/abc123/logs").query({ follow: "nope" });

      expect(response.status).toBe(400);
    });

    it("returns 404 when the container doesn't exist, before ever opening a stream", async () => {
      mockDockerService.getContainer.mockRejectedValue(new Error("Container not found"));

      const response = await request(server).get("/containers/missing/logs").query({ follow: "true" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Container not found");
      expect(mockDockerService.streamContainerLogs).not.toHaveBeenCalled();
    });

    it("handles one-shot fetch errors from the docker service", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.getContainerLogs.mockRejectedValue(new Error("Docker daemon not running"));

      const response = await request(server).get("/containers/abc123/logs");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Docker daemon not running");
    });

    it("streams live frames as SSE when follow=true, preserving order", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.streamContainerLogs.mockResolvedValue(fakeLogStream([makeDockerMuxedBuffer("first\n", ""), makeDockerMuxedBuffer("", "second\n")]));

      const response = await request(server).get("/containers/abc123/logs").query({ follow: "true" });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");

      const events = response.text.trim().split("\n\n").filter(Boolean);
      const dataLines = events.filter(e => e.startsWith("event: log")).map(e => JSON.parse(e.split("data: ")[1]));

      expect(dataLines).toEqual([
        { stream: "stdout", message: "first\n" },
        { stream: "stderr", message: "second\n" },
      ]);
    });

    it("reassembles a frame split across two chunks in follow mode", async () => {
      const full = makeDockerMuxedBuffer("hello world\n", "");
      const firstChunk = full.subarray(0, 10);
      const secondChunk = full.subarray(10);

      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.streamContainerLogs.mockResolvedValue(fakeLogStream([firstChunk, secondChunk]));

      const response = await request(server).get("/containers/abc123/logs").query({ follow: "true" });

      const events = response.text.trim().split("\n\n").filter(Boolean);
      const dataLines = events.filter(e => e.startsWith("event: log")).map(e => JSON.parse(e.split("data: ")[1]));

      expect(dataLines).toEqual([{ stream: "stdout", message: "hello world\n" }]);
    });

    it("passes the request's AbortSignal through to streamContainerLogs", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.streamContainerLogs.mockResolvedValue(fakeLogStream([]));

      await request(server).get("/containers/abc123/logs").query({ follow: "true" });

      expect(mockDockerService.streamContainerLogs).toHaveBeenCalledWith(
        "abc123",
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
    });

    it("emits an SSE error event when the docker stream fails mid-stream", async () => {
      mockDockerService.getContainer.mockResolvedValue({ Id: "abc123", Config: { Tty: false } });
      mockDockerService.streamContainerLogs.mockRejectedValue(new Error("stream broke"));

      const response = await request(server).get("/containers/abc123/logs").query({ follow: "true" });

      // Headers are already committed by the time the stream fails, so this can't become a
      // real 4xx/5xx — the failure surfaces as an SSE error frame instead.
      expect(response.status).toBe(200);
      expect(response.text).toContain("event: error");
      expect(response.text).toContain("stream broke");
    });
  });
});
