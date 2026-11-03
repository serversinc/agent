import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { SelfUpdateService } from "../../src/services/SelfUpdateService";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

vi.mock("../../src/config", () => ({ default: { PORT: 7567 } }));

const { postSafeMock } = vi.hoisted(() => ({ postSafeMock: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/Http", () => ({ httpService: { postSafe: postSafeMock } }));

const IMAGE = `ghcr.io/serversinc/agent@sha256:${"a".repeat(64)}`;
const IMAGE_B = `ghcr.io/serversinc/agent@sha256:${"b".repeat(64)}`;
const IMAGE_C = `ghcr.io/serversinc/agent@sha256:${"c".repeat(64)}`;
const IMAGE_OLD = `ghcr.io/serversinc/agent@sha256:${"d".repeat(64)}`;

function makeDocker(overrides: Record<string, unknown> = {}) {
  return {
    getContainer: vi.fn().mockResolvedValue({
      Name: "/agent",
      Config: { Labels: { "traefik.enable": "true" }, Env: ["A=1"], ExposedPorts: {} },
      HostConfig: { Binds: ["/agent:/agent"] },
    }),
    checkImageExists: vi.fn().mockResolvedValue(true),
    pullImage: vi.fn().mockResolvedValue(undefined),
    createContainer: vi.fn().mockResolvedValue({ id: "sibling-000000000000" }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    renameContainer: vi.fn().mockResolvedValue(undefined),
    listContainersByLabel: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeService(docker: ReturnType<typeof makeDocker>, opts: { jitterMs?: () => number; scheduleFn?: (fn: () => void, ms: number) => void } = {}) {
  const scheduleFn = opts.scheduleFn ?? ((fn: () => void) => fn());

  return new SelfUpdateService(docker as never, "self-container-id", "1.0.0", opts.jitterMs ?? (() => 0), scheduleFn);
}

describe("SelfUpdateService", () => {
  beforeEach(() => {
    // The global setup's afterEach runs vi.resetAllMocks(), which wipes this
    // hoisted mock's implementation between tests.
    postSafeMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe("image allowlist", () => {
    const rejected = [
      ["another repository", `ghcr.io/acme/agent@sha256:${"a".repeat(64)}`],
      ["another registry", `docker.io/serversinc/agent@sha256:${"a".repeat(64)}`],
      ["a lookalike registry host", `ghcr.io.evil.example/serversinc/agent@sha256:${"a".repeat(64)}`],
      ["a repository with the agent name as a prefix", `ghcr.io/serversinc/agent-evil@sha256:${"a".repeat(64)}`],
      ["a tag without a digest", "ghcr.io/serversinc/agent:2.0.0"],
      ["no tag and no digest", "ghcr.io/serversinc/agent"],
      ["a tag and a digest", `ghcr.io/serversinc/agent:2.0.0@sha256:${"a".repeat(64)}`],
      ["a short digest", "ghcr.io/serversinc/agent@sha256:abc123"],
      ["an uppercase digest", `ghcr.io/serversinc/agent@sha256:${"A".repeat(64)}`],
      ["text after the digest", `ghcr.io/serversinc/agent@sha256:${"a".repeat(64)} --privileged`],
    ] as const;

    it.each(rejected)("does not schedule an update for %s", (_name, image) => {
      const scheduleFn = vi.fn();
      const service = makeService(makeDocker(), { scheduleFn });

      for (let i = 0; i < 3; i++) {
        service.onHeartbeatTarget({ target_version: "2.0.0", target_image: image });
      }

      expect(scheduleFn).toHaveBeenCalledTimes(0);
    });

    it.each(rejected)("beginUpdate refuses %s and pulls nothing, creates nothing and reports no update", async (_name, image) => {
      const docker = makeDocker();
      const service = makeService(docker);

      await expect(service.beginUpdate({ version: "2.0.0", image })).rejects.toThrow(
        "Refusing to self-update: image is not ghcr.io/serversinc/agent@sha256:<digest>",
      );

      expect(docker.pullImage).toHaveBeenCalledTimes(0);
      expect(docker.createContainer).toHaveBeenCalledTimes(0);
      expect(postSafeMock).toHaveBeenCalledTimes(0);
    });

    it("schedules an update for the agent image pinned by digest", () => {
      const scheduleFn = vi.fn();
      const service = makeService(makeDocker(), { scheduleFn });

      for (let i = 0; i < 3; i++) {
        service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });
      }

      expect(scheduleFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("debounce + jitter gating", () => {
    it("does not act on a single heartbeat reporting a new target", () => {
      const docker = makeDocker();
      const service = makeService(docker);

      service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });

      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it("does not act on heartbeats disagreeing on the target version", () => {
      const docker = makeDocker();
      const service = makeService(docker);

      service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });
      service.onHeartbeatTarget({ target_version: "2.0.1", target_image: IMAGE_B });
      service.onHeartbeatTarget({ target_version: "2.0.2", target_image: IMAGE_C });

      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it("ignores a target matching the running version", () => {
      const docker = makeDocker();
      const service = makeService(docker);

      service.onHeartbeatTarget({ target_version: "1.0.0", target_image: IMAGE_OLD });
      service.onHeartbeatTarget({ target_version: "1.0.0", target_image: IMAGE_OLD });
      service.onHeartbeatTarget({ target_version: "1.0.0", target_image: IMAGE_OLD });

      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it("triggers the update only once threshold consecutive heartbeats agree, applying jitter", async () => {
      const docker = makeDocker();
      const jitterMs = vi.fn().mockReturnValue(1234);
      const scheduleFn = vi.fn((fn: () => void) => fn());
      const service = makeService(docker, { jitterMs, scheduleFn });

      service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });
      service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });
      expect(scheduleFn).not.toHaveBeenCalled();

      service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });

      expect(scheduleFn).toHaveBeenCalledWith(expect.any(Function), 1234);
      await vi.waitFor(() => expect(docker.createContainer).toHaveBeenCalledTimes(1));
    });

    it("only triggers once even if further matching heartbeats arrive", async () => {
      const docker = makeDocker();
      const service = makeService(docker);

      for (let i = 0; i < 6; i++) {
        service.onHeartbeatTarget({ target_version: "2.0.0", target_image: IMAGE });
      }

      await vi.waitFor(() => expect(docker.createContainer).toHaveBeenCalledTimes(1));
    });
  });

  describe("beginUpdate — sibling creation", () => {
    it("creates a labeled sibling from the running container's config, without touching the running container", async () => {
      const docker = makeDocker();
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: IMAGE,
          Env: ["A=1"],
          Labels: expect.objectContaining({ "traefik.enable": "true", [SelfUpdateService.ROLE_LABEL]: SelfUpdateService.ROLE_VALUE }),
          HostConfig: { Binds: ["/agent:/agent"], Privileged: true, PidMode: "host" },
        }),
      );
      expect(docker.startContainer).toHaveBeenCalledWith("sibling-000000000000");
      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_update_started" }));
    });

    it("forces Privileged and PidMode on the sibling and drops GroupAdd, even if the predecessor didn't have them", async () => {
      const docker = makeDocker({
        getContainer: vi.fn().mockResolvedValue({
          Name: "/agent",
          Config: { Labels: {}, Env: ["A=1"], ExposedPorts: {} },
          HostConfig: { Binds: ["/agent:/agent"], Privileged: false, GroupAdd: ["999"] },
        }),
      });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: { Binds: ["/agent:/agent"], Privileged: true, PidMode: "host" },
        }),
      );
    });

    it("strips AGENT_VERSION from the copied env so the new image's baked value wins", async () => {
      const docker = makeDocker({
        getContainer: vi.fn().mockResolvedValue({
          Name: "/agent",
          Config: { Labels: {}, Env: ["A=1", "AGENT_VERSION=1.0.0", "B=2"], ExposedPorts: {} },
          HostConfig: {},
        }),
      });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Env: ["A=1", "B=2"] }));
    });

    it("pulls the target image only if not already present", async () => {
      const docker = makeDocker({ checkImageExists: vi.fn().mockResolvedValue(false) });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.pullImage).toHaveBeenCalledWith(IMAGE);
    });
  });

  describe("checkForTakeoverOnBoot — self-check gate", () => {
    it("normal boot: does nothing when no labeled sibling exists", async () => {
      const docker = makeDocker();
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(docker.renameContainer).not.toHaveBeenCalled();
    });

    it("pass path: removes the predecessor gracefully and renames itself to the canonical name", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({ listContainersByLabel: vi.fn().mockResolvedValue([{ Id: "predecessor-container-id" }]) });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).toHaveBeenCalledWith("predecessor-container-id", SelfUpdateService.STOP_GRACE_SECONDS);
      expect(docker.removeContainer).toHaveBeenCalledWith("predecessor-container-id", true);
      expect(docker.renameContainer).toHaveBeenCalledWith("self-container-id", SelfUpdateService.CANONICAL_NAME);
      expect(postSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_update_completed" }));
    });

    it("fail path: leaves the predecessor untouched and cleans itself up when the local health check fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      const docker = makeDocker({ listContainersByLabel: vi.fn().mockResolvedValue([{ Id: "predecessor-container-id" }]) });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.removeContainer).toHaveBeenCalledWith("self-container-id", true);
      expect(docker.renameContainer).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_update_failed" }));
    });

    it("fail path: leaves the predecessor untouched when the control-plane round trip fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({ listContainersByLabel: vi.fn().mockResolvedValue([{ Id: "predecessor-container-id" }]) });
      postSafeMock.mockResolvedValueOnce(false);
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.removeContainer).toHaveBeenCalledWith("self-container-id", true);
      expect(docker.renameContainer).not.toHaveBeenCalled();
    });

    it("reports a failure and rolls itself back when retiring the predecessor fails after a passed self-check", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({
        listContainersByLabel: vi.fn().mockResolvedValue([{ Id: "predecessor-container-id" }]),
        removeContainer: vi.fn().mockImplementation(async (id: string) => {
          if (id === "predecessor-container-id") {
            throw new Error("no such container");
          }
        }),
      });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.renameContainer).not.toHaveBeenCalled();
      expect(docker.removeContainer).toHaveBeenCalledWith("predecessor-container-id", true);
      expect(docker.removeContainer).toHaveBeenCalledWith("self-container-id", true);
      expect(postSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_update_failed" }));
    });

    it("finds an unlabelled predecessor by its canonical container name", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({
        listContainersByLabel: vi.fn().mockResolvedValue([]),
        listContainers: vi.fn().mockResolvedValue([{ id: "legacy-agent-id", name: "/agent" }]),
      });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).toHaveBeenCalledWith("legacy-agent-id", SelfUpdateService.STOP_GRACE_SECONDS);
      expect(docker.removeContainer).toHaveBeenCalledWith("legacy-agent-id", true);
      expect(docker.renameContainer).toHaveBeenCalledWith("self-container-id", SelfUpdateService.CANONICAL_NAME);
    });

    it("does not treat itself as the predecessor when it already holds the canonical name", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({
        listContainersByLabel: vi.fn().mockResolvedValue([]),
        listContainers: vi.fn().mockResolvedValue([{ id: "self-container-id", name: "/agent" }]),
      });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.renameContainer).not.toHaveBeenCalled();
    });

    it("ignores itself when it appears in the labeled list", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const docker = makeDocker({ listContainersByLabel: vi.fn().mockResolvedValue([{ Id: "self-container-id" }]) });
      const service = makeService(docker);

      await service.checkForTakeoverOnBoot();

      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.renameContainer).not.toHaveBeenCalled();
    });
  });

  describe("handoff watchdog", () => {
    it("cleans up a sibling that never completed the handoff in time", async () => {
      const docker = makeDocker({
        getContainer: vi.fn().mockResolvedValue({ Name: "/agent-update-abc123", Config: {}, HostConfig: {} }),
      });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.removeContainer).toHaveBeenCalledWith("sibling-000000000000", true);
    });

    it("does nothing when the sibling already took over (renamed to canonical)", async () => {
      const docker = makeDocker({
        getContainer: vi
          .fn()
          .mockResolvedValueOnce({ Name: "/agent", Config: { Labels: {}, Env: [], ExposedPorts: {} }, HostConfig: {} })
          .mockResolvedValueOnce({ Name: "/agent" }),
      });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.removeContainer).not.toHaveBeenCalled();
    });

    it("does nothing when the sibling is already gone", async () => {
      const docker = makeDocker({
        getContainer: vi
          .fn()
          .mockResolvedValueOnce({ Name: "/agent", Config: { Labels: {}, Env: [], ExposedPorts: {} }, HostConfig: {} })
          .mockRejectedValueOnce(new Error("no such container")),
      });
      const service = makeService(docker);

      await service.beginUpdate({ version: "2.0.0", image: IMAGE });

      expect(docker.removeContainer).not.toHaveBeenCalled();
    });
  });
});
