import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createVolumeHandlers } from "../../src/controllers/volumes";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Volume Handlers", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    const handlers = createVolumeHandlers(mockDockerService);
    const s = await makeApp(
      app => {
        app.get("/volumes", handlers.list);
        app.get("/volumes/:name", handlers.get);
        app.post("/volumes", handlers.create);
        app.delete("/volumes/:name", handlers.remove);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  describe("GET /volumes", () => {
    it("should return list of volumes", async () => {
      mockDockerService.docker.listVolumes.mockResolvedValue({ Volumes: [{ Name: "volume1" }] });

      const response = await request(server).get("/volumes");

      expect(response.status).toBe(200);
      expect(mockDockerService.docker.listVolumes).toHaveBeenCalledTimes(1);
    });

    it("should handle list errors", async () => {
      mockDockerService.docker.listVolumes.mockRejectedValue(new Error("Docker daemon not running"));

      const response = await request(server).get("/volumes");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Docker daemon not running");
    });
  });

  describe("GET /volumes/:name", () => {
    it("should return a volume by name", async () => {
      const mockVolume = {
        inspect: vi.fn().mockResolvedValue({ Name: "volume1" }),
      };
      mockDockerService.docker.getVolume.mockReturnValue(mockVolume);

      const response = await request(server).get("/volumes/volume1");

      expect(response.status).toBe(200);
      expect(response.body.Name).toBe("volume1");
      expect(mockDockerService.docker.getVolume).toHaveBeenCalledWith("volume1");
    });

    it("should return 404 for non-existent volume", async () => {
      const mockVolume = {
        inspect: vi.fn().mockRejectedValue(new Error("Volume not found")),
      };
      mockDockerService.docker.getVolume.mockReturnValue(mockVolume);

      const response = await request(server).get("/volumes/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Volume not found");
    });
  });

  describe("POST /volumes", () => {
    it("should create a volume", async () => {
      mockDockerService.docker.createVolume.mockResolvedValue({ Name: "my-volume" });

      const response = await request(server).post("/volumes").send({ name: "my-volume" });

      expect(response.status).toBe(201);
      expect(response.body.Name).toBe("my-volume");
      expect(mockDockerService.docker.createVolume).toHaveBeenCalled();
    });

    it("should handle create errors", async () => {
      mockDockerService.docker.createVolume.mockRejectedValue(new Error("volume already exists"));

      const response = await request(server).post("/volumes").send({ name: "existing-volume" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("volume already exists");
    });
  });

  describe("DELETE /volumes/:name", () => {
    it("should remove a volume", async () => {
      const mockVolume = {
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockDockerService.docker.getVolume.mockReturnValue(mockVolume);

      const response = await request(server).delete("/volumes/volume1");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockVolume.remove).toHaveBeenCalled();
    });

    it("should handle remove errors", async () => {
      const mockVolume = {
        remove: vi.fn().mockRejectedValue(new Error("volume in use")),
      };
      mockDockerService.docker.getVolume.mockReturnValue(mockVolume);

      const response = await request(server).delete("/volumes/volume1");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("volume in use");
    });
  });
});
