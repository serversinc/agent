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
  let mockBuildService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    mockBuildService = { buildFromRepo: vi.fn().mockResolvedValue(undefined) };
    const handlers = createImageHandlers(mockDockerService, mockBuildService);
    const s = await makeApp(
      app => {
        app.get("/images", handlers.list);
        app.get("/images/:id", handlers.get);
        app.post("/images/pull", handlers.pull);
        app.post("/images", handlers.build);
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

  describe("POST /images", () => {
    const body = { name: "owner/repo", tag: "abc123", applicationId: "app_1", deploymentId: "deploy_1", token: "gh_token" };

    it("starts a build and returns 202 immediately", async () => {
      const response = await request(server).post("/images").send(body);

      expect(response.status).toBe(202);
      expect(response.body.success).toBe(true);
      expect(response.body.image).toEqual({ name: "owner/repo", tag: "abc123", applicationId: "app_1" });
      expect(mockBuildService.buildFromRepo).toHaveBeenCalledWith(body);
    });

    it("does not wait for the build to finish before responding", async () => {
      let resolveBuild: () => void = () => {};
      mockBuildService.buildFromRepo.mockReturnValue(new Promise<void>(resolve => (resolveBuild = resolve)));

      const response = await request(server).post("/images").send(body);

      expect(response.status).toBe(202);
      resolveBuild();
    });

    it("still returns 202 when the build promise rejects asynchronously", async () => {
      mockBuildService.buildFromRepo.mockRejectedValue(new Error("boom"));

      const response = await request(server).post("/images").send(body);

      expect(response.status).toBe(202);
    });
  });

  describe("DELETE /images/:id", () => {
    it("should remove an image, defaulting force to false", async () => {
      mockDockerService.removeImage.mockResolvedValue(undefined);

      const response = await request(server).delete("/images/sha256:abc123");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDockerService.removeImage).toHaveBeenCalledWith("sha256:abc123", false);
    });

    it("should pass force=true through when the query flag is set", async () => {
      mockDockerService.removeImage.mockResolvedValue(undefined);

      const response = await request(server).delete("/images/sha256:abc123?force=true");

      expect(response.status).toBe(200);
      expect(mockDockerService.removeImage).toHaveBeenCalledWith("sha256:abc123", true);
    });

    it("surfaces the daemon status when the image is still in use", async () => {
      mockDockerService.removeImage.mockRejectedValue(
        Object.assign(new Error("conflict: unable to delete sha256:abc123 - image is being used by running container 9c1"), {
          statusCode: 409,
        }),
      );

      const response = await request(server).delete("/images/sha256:abc123");

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("image is being used by running container");
    });
  });

  describe("POST /images/prune", () => {
    it("prunes dangling images and returns reclaimed space", async () => {
      mockDockerService.pruneImages.mockResolvedValue({
        ImagesDeleted: [{ Deleted: "sha256:old" }],
        SpaceReclaimed: 4096,
      });

      const response = await request(server).post("/images/prune");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        space_reclaimed: 4096,
        images_deleted: [{ Deleted: "sha256:old" }],
      });
      expect(mockDockerService.pruneImages).toHaveBeenCalledWith(false);
    });

    it("prunes all unused images when all=true", async () => {
      mockDockerService.pruneImages.mockResolvedValue({ ImagesDeleted: [], SpaceReclaimed: 0 });

      const response = await request(server).post("/images/prune?all=true");

      expect(response.status).toBe(200);
      expect(mockDockerService.pruneImages).toHaveBeenCalledWith(true);
    });

    it("should handle prune errors", async () => {
      mockDockerService.pruneImages.mockRejectedValue(new Error("prune failed"));

      const response = await request(server).post("/images/prune");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("prune failed");
    });
  });
});
