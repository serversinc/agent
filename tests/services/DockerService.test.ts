import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerService } from "../../src/services/Docker";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

// Docker.ts pulls in the real config module at import time, which requires a full .env (PEM
// path, SERVER_ID, etc.) that isn't present in CI — mock it rather than needing those secrets.
vi.mock("../../src/config", () => ({ default: { DOCKER_SOCKET: "/tmp/nonexistent.sock" } }));

// DockerService always constructs a real dockerode client, so we monkeypatch the low-level
// `docker.buildImage` / `docker.pull` / `docker.modem.followProgress` calls it wraps rather
// than mocking the whole `dockerode` module.
describe("DockerService", () => {
  let service: DockerService;

  beforeEach(() => {
    service = new DockerService("/tmp/nonexistent.sock");
  });

  describe("buildImage", () => {
    it("resolves when the build stream reports no error events", async () => {
      (service.docker as any).buildImage = vi.fn().mockResolvedValue("fake-stream");
      (service.docker as any).modem = {
        followProgress: (_stream: unknown, cb: any, onProgress: any) => {
          onProgress({ stream: "Step 1/1 : FROM scratch\n" });
          cb(null, [{ stream: "Step 1/1 : FROM scratch\n" }, { stream: "Successfully built abc123\n" }]);
        },
      };

      await expect(service.buildImage("/ctx", "myapp:sha")).resolves.toBeUndefined();
      expect((service.docker as any).buildImage).toHaveBeenCalledWith({ context: "/ctx", src: ["."] }, { t: "myapp:sha", buildargs: undefined });
    });

    it("passes buildArgs through as dockerode's buildargs option", async () => {
      (service.docker as any).buildImage = vi.fn().mockResolvedValue("fake-stream");
      (service.docker as any).modem = { followProgress: (_stream: unknown, cb: any) => cb(null, []) };

      await service.buildImage("/ctx", "myapp:sha", { NODE_ENV: "production" });

      expect((service.docker as any).buildImage).toHaveBeenCalledWith(
        { context: "/ctx", src: ["."] },
        { t: "myapp:sha", buildargs: { NODE_ENV: "production" } },
      );
    });

    it("rejects with the embedded error message when the build fails (HTTP 200, error in the stream)", async () => {
      (service.docker as any).buildImage = vi.fn().mockResolvedValue("fake-stream");
      (service.docker as any).modem = {
        followProgress: (_stream: unknown, cb: any) => {
          cb(null, [
            { stream: "Step 1/2 : FROM node:18-slim\n" },
            { errorDetail: { message: "The command '/bin/sh -c false' returned a non-zero code: 1" }, error: "..." },
          ]);
        },
      };

      await expect(service.buildImage("/ctx", "myapp:sha")).rejects.toThrow("returned a non-zero code: 1");
    });

    it("rejects when the build stream itself errors out", async () => {
      (service.docker as any).buildImage = vi.fn().mockResolvedValue("fake-stream");
      (service.docker as any).modem = {
        followProgress: (_stream: unknown, cb: any) => {
          cb(new Error("daemon connection lost"));
        },
      };

      await expect(service.buildImage("/ctx", "myapp:sha")).rejects.toThrow("daemon connection lost");
    });
  });

  describe("pullImage", () => {
    it("resolves when the pull stream completes without error", async () => {
      (service.docker as any).pull = (_name: string, _opts: unknown, cb: any) => cb(null, "fake-stream");
      (service.docker as any).modem = {
        followProgress: (_stream: unknown, cb: any) => cb(null, [{ status: "Pull complete" }]),
      };

      await expect(service.pullImage("nginx:latest")).resolves.toBeUndefined();
    });

    it("rejects when docker.pull itself errors", async () => {
      (service.docker as any).pull = (_name: string, _opts: unknown, cb: any) => cb(new Error("pull access denied"));

      await expect(service.pullImage("private:latest")).rejects.toThrow("pull access denied");
    });

    it("rejects when the pull stream errors out mid-transfer", async () => {
      (service.docker as any).pull = (_name: string, _opts: unknown, cb: any) => cb(null, "fake-stream");
      (service.docker as any).modem = {
        followProgress: (_stream: unknown, cb: any) => cb(new Error("connection reset")),
      };

      await expect(service.pullImage("nginx:latest")).rejects.toThrow("connection reset");
    });
  });

  describe("listContainersByLabel", () => {
    it("filters containers by a label=value pair", async () => {
      (service.docker as any).listContainers = vi.fn().mockResolvedValue([{ Id: "abc123" }]);

      const result = await service.listContainersByLabel("com.serversinc.role", "agent");

      expect((service.docker as any).listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ["com.serversinc.role=agent"] },
      });
      expect(result).toEqual([{ Id: "abc123" }]);
    });
  });

  describe("renameContainer", () => {
    it("renames the given container", async () => {
      const rename = vi.fn().mockResolvedValue(undefined);
      (service.docker as any).getContainer = vi.fn().mockReturnValue({ rename });

      await service.renameContainer("abc123", "agent");

      expect((service.docker as any).getContainer).toHaveBeenCalledWith("abc123");
      expect(rename).toHaveBeenCalledWith({ name: "agent" });
    });

    it("propagates a rename failure", async () => {
      const rename = vi.fn().mockRejectedValue(new Error("name already in use"));
      (service.docker as any).getContainer = vi.fn().mockReturnValue({ rename });

      await expect(service.renameContainer("abc123", "agent")).rejects.toThrow("name already in use");
    });
  });
});
