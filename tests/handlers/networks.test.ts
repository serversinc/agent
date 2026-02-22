import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createNetworkHandlers } from "../../src/controllers/networks";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Network Handlers", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    const handlers = createNetworkHandlers(mockDockerService);
    const s = await makeApp(
      app => {
        app.get("/networks", handlers.list);
        app.get("/networks/:id", handlers.get);
        app.post("/networks", handlers.create);
        app.delete("/networks/:id", handlers.remove);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  describe("GET /networks", () => {
    it("should return list of networks", async () => {
      mockDockerService.docker.listNetworks.mockResolvedValue([{ Id: "network1", Name: "bridge" }]);

      const response = await request(server).get("/networks");

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].Id).toBe("network1");
      expect(mockDockerService.docker.listNetworks).toHaveBeenCalledTimes(1);
    });

    it("should handle list errors", async () => {
      mockDockerService.docker.listNetworks.mockRejectedValue(new Error("Docker daemon not running"));

      const response = await request(server).get("/networks");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Docker daemon not running");
    });
  });

  describe("GET /networks/:id", () => {
    it("should return a network by id", async () => {
      const mockNetwork = {
        inspect: vi.fn().mockResolvedValue({ Id: "network1", Name: "test-network" }),
      };
      mockDockerService.docker.getNetwork.mockReturnValue(mockNetwork);

      const response = await request(server).get("/networks/network1");

      expect(response.status).toBe(200);
      expect(response.body.Id).toBe("network1");
      expect(mockDockerService.docker.getNetwork).toHaveBeenCalledWith("network1");
    });

    it("should return 404 for non-existent network", async () => {
      const mockNetwork = {
        inspect: vi.fn().mockRejectedValue(new Error("Network not found")),
      };
      mockDockerService.docker.getNetwork.mockReturnValue(mockNetwork);

      const response = await request(server).get("/networks/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Network not found");
    });
  });

  describe("POST /networks", () => {
    it("should create a network", async () => {
      const mockNetwork = {
        inspect: vi.fn().mockResolvedValue({ Id: "new-network", Name: "my-network" }),
      };
      mockDockerService.docker.createNetwork.mockResolvedValue(mockNetwork);

      const response = await request(server).post("/networks").send({ name: "my-network" });

      expect(response.status).toBe(201);
      expect(response.body.Name).toBe("my-network");
      expect(mockDockerService.docker.createNetwork).toHaveBeenCalled();
    });

    it("should handle create errors", async () => {
      mockDockerService.docker.createNetwork.mockRejectedValue(new Error("network already exists"));

      const response = await request(server).post("/networks").send({ name: "existing-network" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("network already exists");
    });
  });

  describe("DELETE /networks/:id", () => {
    it("should remove a network", async () => {
      const mockNetwork = {
        remove: vi.fn().mockResolvedValue(undefined),
      };
      mockDockerService.docker.getNetwork.mockReturnValue(mockNetwork);

      const response = await request(server).delete("/networks/network1");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockNetwork.remove).toHaveBeenCalled();
    });

    it("should handle remove errors", async () => {
      const mockNetwork = {
        remove: vi.fn().mockRejectedValue(new Error("network in use")),
      };
      mockDockerService.docker.getNetwork.mockReturnValue(mockNetwork);

      const response = await request(server).delete("/networks/network1");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("network in use");
    });
  });
});
