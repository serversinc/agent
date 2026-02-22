import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createImageHandlers } from "../../src/controllers/images";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Image Handlers", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    const handlers = createImageHandlers(mockDockerService);
    const s = await makeApp(
      app => {
        app.get("/images", handlers.list);
        app.get("/images/:id", handlers.get);
        app.post("/images/pull", handlers.pull);
        app.delete("/images/:id", handlers.remove);
        app.post("/images/prune", handlers.prune);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  describe("GET /images", () => {
    it("should return list of images", async () => {
      mockDockerService.listImages.mockResolvedValue([{ Id: "sha256:abc123", RepoTags: ["nginx:latest"] }]);

      const response = await request(server).get("/images");

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].Id).toBe("sha256:abc123");
      expect(mockDockerService.listImages).toHaveBeenCalledTimes(1);
    });

    it("should handle list errors", async () => {
      mockDockerService.listImages.mockRejectedValue(new Error("Docker daemon not running"));

      const response = await request(server).get("/images");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Docker daemon not running");
    });
  });

  describe("GET /images/:id", () => {
    it("should return an image by id", async () => {
      mockDockerService.getImage.mockResolvedValue({ Id: "sha256:abc123", RepoTags: ["nginx:latest"] });

      const response = await request(server).get("/images/sha256:abc123");

      expect(response.status).toBe(200);
      expect(response.body.Id).toBe("sha256:abc123");
      expect(mockDockerService.getImage).toHaveBeenCalledWith("sha256:abc123");
    });

    it("should return 404 for non-existent image", async () => {
      mockDockerService.getImage.mockRejectedValue(new Error("Image not found"));

      const response = await request(server).get("/images/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Image not found");
    });
  });

  describe("POST /images/pull", () => {
    it("should pull an image", async () => {
      mockDockerService.pullImage.mockResolvedValue(undefined);

      const response = await request(server).post("/images/pull").send({ name: "nginx:latest" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.image.name).toBe("nginx:latest");
      expect(mockDockerService.pullImage).toHaveBeenCalledWith("nginx:latest");
    });

    it("should handle pull errors", async () => {
      mockDockerService.pullImage.mockRejectedValue(new Error("pull access denied"));

      const response = await request(server).post("/images/pull").send({ name: "private:latest" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("pull access denied");
    });
  });

  describe("DELETE /images/:id", () => {
    it("should remove an image", async () => {
      mockDockerService.removeImage.mockResolvedValue(undefined);

      const response = await request(server).delete("/images/sha256:abc123");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDockerService.removeImage).toHaveBeenCalledWith("sha256:abc123");
    });

    it("should handle remove errors", async () => {
      mockDockerService.removeImage.mockRejectedValue(new Error("image is being used"));

      const response = await request(server).delete("/images/sha256:abc123");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("image is being used");
    });
  });

  describe("POST /images/prune", () => {
    it("should prune unused images", async () => {
      mockDockerService.pruneImages.mockResolvedValue({ ImagesDeleted: [], SpaceReclaimed: 0 });

      const response = await request(server).post("/images/prune");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDockerService.pruneImages).toHaveBeenCalledTimes(1);
    });

    it("should handle prune errors", async () => {
      mockDockerService.pruneImages.mockRejectedValue(new Error("prune failed"));

      const response = await request(server).post("/images/prune");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("prune failed");
    });
  });
});
