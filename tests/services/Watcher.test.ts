import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { WatcherService } from "../../src/services/Watcher";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/services/Http", () => ({
  httpService: { postSafe: vi.fn().mockResolvedValue(true) },
}));

import { httpService } from "../../src/services/Http";

function fakeEventStream(): EventEmitter & { destroy: () => void } {
  const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
  stream.destroy = vi.fn();
  return stream;
}

describe("WatcherService", () => {
  let mockDockerService: any;
  let stream: EventEmitter & { destroy: () => void };

  beforeEach(() => {
    stream = fakeEventStream();
    mockDockerService = createDockerMock({
      docker: { getEvents: vi.fn().mockResolvedValue(stream) } as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to dockerode's event stream (not a spawned CLI process) and reaches running state", async () => {
    const watcher = new WatcherService(mockDockerService);

    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDockerService.docker.getEvents).toHaveBeenCalled();
    expect(watcher.getState()).toBe("running");
  });

  it("forwards a container create event to Core once enriched from the container inspect", async () => {
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "abc123",
      Name: "/my-app-container",
      Config: { Image: "nginx:latest", Env: ["CORE_APP_ID=app-1", "CORE_DEPLOYMENT_ID=dep-1"] },
      State: { Status: "running" },
      Created: "2026-01-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "container",
          Action: "create",
          Actor: { ID: "abc123", Attributes: {} },
          time: 0,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "docker_event",
        payload: expect.objectContaining({
          event: "create",
          id: "abc123",
          attributes: expect.objectContaining({
            application_id: "app-1",
            deployment_id: "dep-1",
          }),
        }),
      }),
    );
  });

  it("enriches an image pull event from the image inspect before forwarding", async () => {
    mockDockerService.getImage = vi.fn().mockResolvedValue({
      Id: "sha256:redis7",
      RepoTags: ["redis:7"],
      RepoDigests: ["redis@sha256:digest"],
      Size: 128_000_000,
      Created: "2026-09-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "pull",
          Actor: { ID: "redis:7", Attributes: { name: "redis:7" } },
          time: 1_700_000_000,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockDockerService.getImage).toHaveBeenCalledWith("redis:7");
    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: {
        event: "pull",
        type: "image",
        id: "redis:7",
        time: 1_700_000_000,
        attributes: {
          docker_id: "sha256:redis7",
          repo_tags: ["redis:7"],
          repo_digests: ["redis@sha256:digest"],
          size: 128_000_000,
          created: "2026-09-01T00:00:00Z",
        },
      },
    });
  });

  it("still forwards an image pull event when the inspect fails", async () => {
    mockDockerService.getImage = vi.fn().mockRejectedValue(new Error("no such image"));

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "pull",
          Actor: { ID: "ghost:latest", Attributes: { name: "ghost:latest" } },
          time: 42,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: {
        event: "pull",
        type: "image",
        id: "ghost:latest",
        time: 42,
        attributes: { name: "ghost:latest" },
      },
    });
  });

  it("forwards an image delete event without an inspect", async () => {
    mockDockerService.getImage = vi.fn();

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "delete",
          Actor: { ID: "sha256:gone", Attributes: {} },
          time: 7,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockDockerService.getImage).not.toHaveBeenCalled();
    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: { event: "delete", type: "image", id: "sha256:gone", time: 7, attributes: {} },
    });
  });

  it("does not forward image tag events", async () => {
    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "tag",
          Actor: { ID: "sha256:x", Attributes: {} },
          time: 1,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).not.toHaveBeenCalled();
  });

  it("drops back to stopped when the event stream ends, so scheduleRestart can retry", async () => {
    vi.useFakeTimers();

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(watcher.getState()).toBe("running");

    stream.emit("end");

    expect(watcher.getState()).toBe("stopped");

    // Drain the pending scheduleRestart() timer so it doesn't leak past the test.
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });
});
