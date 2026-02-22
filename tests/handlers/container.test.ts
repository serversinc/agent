import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createContainerHandlers } from "../../src/controllers/containers";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";
import { makeDockerMuxedBuffer } from "../helpers/streams";

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
});
