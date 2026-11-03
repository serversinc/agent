import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

vi.mock("../../src/config", () => ({ default: { HEARTBEAT_INTERVAL_MS: 300000 } }));

const { postMock, postSafeMock } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({}),
  postSafeMock: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/Http", () => ({ httpService: { post: postMock, postSafe: postSafeMock } }));

const { collectMock } = vi.hoisted(() => ({ collectMock: vi.fn() }));
vi.mock("../../src/services/MetricsService", () => ({ metricsService: { collect: collectMock } }));

import { HeartbeatService } from "../../src/services/HeartbeatService";

const USAGE = {
  usage: { cpu: { cores: 4, load: 0.5 }, memory: { total: 8, free: 4 }, uptimeMinutes: 120 },
  disk: [{ Filesystem: "/dev/sda1", Mounted: "/" }],
  network: { deltas: { rxDelta: 10, txDelta: 20 } },
};

describe("HeartbeatService", () => {
  beforeEach(() => {
    postMock.mockResolvedValue({});
    postSafeMock.mockResolvedValue(true);
    collectMock.mockReturnValue(USAGE);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("sends a single alive request carrying the collected usage payload", async () => {
    const service = new HeartbeatService();

    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    expect(postMock).toHaveBeenCalledWith({ type: "alive", ...USAGE });
    service.stop();
  });

  it("still sends the alive request when usage collection throws", async () => {
    collectMock.mockImplementation(() => {
      throw new Error("df failed");
    });
    const service = new HeartbeatService();

    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    expect(postMock).toHaveBeenCalledWith({ type: "alive" });
    service.stop();
  });

  it("repeats on the configured interval", async () => {
    vi.useFakeTimers();
    const service = new HeartbeatService();

    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(300000);
    expect(postMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300000);
    expect(postMock).toHaveBeenCalledTimes(3);

    service.stop();
  });

  it("forwards an agent-update target from the response to the registered handler", async () => {
    const agent = { target_version: "2.0.0", target_image: "ghcr.io/acme/agent:2.0.0" };
    postMock.mockResolvedValue({ agent });
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);

    service.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler).toHaveBeenCalledWith(agent);
    service.stop();
  });

  it("does not call the handler when the response carries no agent target", async () => {
    postMock.mockResolvedValue({});
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);

    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    expect(handler).not.toHaveBeenCalled();
    service.stop();
  });

  it("ping sends a bare alive request with no usage and returns the round-trip result", async () => {
    postSafeMock.mockResolvedValue(false);
    const service = new HeartbeatService();

    const result = await service.ping();

    expect(result).toBe(false);
    expect(postSafeMock).toHaveBeenCalledWith({ type: "alive" });
    expect(collectMock).not.toHaveBeenCalled();
  });
});
