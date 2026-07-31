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
