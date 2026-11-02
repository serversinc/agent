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
import { warn } from "../../src/utils/console";

const OBSERVATION = {
  schema_version: 1,
  sample_id: "11111111-1111-4111-8111-111111111111",
  boot_id: "22222222-2222-4222-8222-222222222222",
  observed_at: "2026-10-29T12:30:45.123Z",
  collectors: {
    cpu: { status: "success", observed_at: "2026-10-29T12:30:45Z", utilisation_pct: 23.5, cores: 8, measured_duration_seconds: 5 },
    memory: { status: "success", observed_at: "2026-10-29T12:30:44Z", used_bytes: 100, total_bytes: 200 },
    network: { status: "success", observed_at: "2026-10-29T12:30:40Z", rx_bytes_delta: 10, tx_bytes_delta: 20, measured_duration_seconds: 60 },
    disk: { status: "success", observed_at: "2026-10-29T12:30:45Z", mounts: [{ mount: "/", size_bytes: 1000, used_bytes: 700, available_bytes: 300 }] },
  },
};

const ACK = { metrics: { status: "persisted", retryable: false } };
const flush = async () => {
  await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
};

describe("HeartbeatService", () => {
  beforeEach(() => {
    postMock.mockResolvedValue(ACK);
    postSafeMock.mockResolvedValue(true);
    collectMock.mockResolvedValue(OBSERVATION);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("sends one full canonical observation per regular heartbeat", async () => {
    const service = new HeartbeatService();
    service.start();
    await flush();

    expect(collectMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith({ type: "alive", observation: OBSERVATION });
    service.stop();
  });

  it("sends bare alive when collection returns null or throws, without retrying", async () => {
    const service = new HeartbeatService();
    collectMock.mockResolvedValueOnce(null);
    service.start();
    await flush();
    expect(postMock).toHaveBeenCalledWith({ type: "alive" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Heartbeat", "Host telemetry unavailable; sending liveness only"));
    service.stop();

    postMock.mockClear();
    collectMock.mockRejectedValueOnce(new Error("collector failure"));
    const secondService = new HeartbeatService();
    secondService.start();
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith({ type: "alive" });
    secondService.stop();
  });

  it("retries a retryable metric failure once with the exact same body", async () => {
    postMock.mockResolvedValueOnce({ metrics: { status: "failed", retryable: true } }).mockResolvedValueOnce(ACK);
    const service = new HeartbeatService();
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));

    expect(postMock.mock.calls[0][0]).toBe(postMock.mock.calls[1][0]);
    expect(collectMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("never exceeds two POSTs when a network failure is followed by retryable failure", async () => {
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce({ metrics: { status: "failed", retryable: true }, agent: { target_version: "2.0.0" } });
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Heartbeat", "Heartbeat metrics ingestion remains retryable after retry"));
    expect(collectMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it.each([
    ["persisted partial", { metrics: { status: "persisted", retryable: false, collector_quality: "partial" } }],
    ["duplicate", { metrics: { status: "duplicate", retryable: false } }],
    ["conflict", { metrics: { status: "conflict", retryable: false } }],
    ["invalid", { metrics: { status: "invalid", retryable: false } }],
    ["failed but not retryable", { metrics: { status: "failed", retryable: false } }],
  ])("does not retry %s acknowledgement", async (_label, ack) => {
    postMock.mockResolvedValue(ack);
    const service = new HeartbeatService();
    service.start();
    await flush();
    await Promise.resolve();
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it.each(["conflict", "invalid"] as const)("logs a bounded rejection for %s without retry", async (status) => {
    postMock.mockResolvedValue({ metrics: { status, retryable: false, reason: "payload details are not logged" } });
    const service = new HeartbeatService();
    service.start();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Heartbeat", `Heartbeat metrics rejected (${status})`));
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it.each([
    ["transient HTTP", new Error("HTTP 503: Service Unavailable")],
    ["rate limited", new Error("HTTP 429: Too Many Requests")],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["fetch network", new TypeError("fetch failed")],
  ])("retries once after %s", async (_label, error) => {
    postMock.mockRejectedValueOnce(error).mockResolvedValueOnce(ACK);
    const service = new HeartbeatService();
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[0][0]).toBe(postMock.mock.calls[1][0]);
    service.stop();
  });

  it.each([
    ["permanent HTTP", new Error("HTTP 401: Unauthorized")],
    ["malformed JSON", new SyntaxError("bad JSON")],
    ["programmer error", new Error("unexpected")],
  ])("does not retry %s", async (_label, error) => {
    postMock.mockRejectedValue(error);
    const service = new HeartbeatService();
    service.start();
    await flush();
    await Promise.resolve();
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("isolates update callback errors from POST retry handling", async () => {
    postMock.mockResolvedValue({ ...ACK, agent: { target_version: "2.0.0" } });
    const handler = vi.fn(() => { throw new TypeError("callback bug"); });
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("forwards update target on a non-retryable partial/invalid acknowledgement", async () => {
    const agent = { target_version: "2.0.0", target_image: "ghcr.io/acme/agent:2.0.0" };
    postMock.mockResolvedValue({ metrics: { status: "invalid", retryable: false }, agent });
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(agent);
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("processes an update target from the first response before a metric retry", async () => {
    const agent = { target_version: "2.1.0" };
    postMock.mockResolvedValueOnce({ metrics: { status: "failed", retryable: true }, agent }).mockResolvedValueOnce(ACK);
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(agent);
    service.stop();
  });

  it("does not retry or handle targets from a response arriving after stop", async () => {
    let resolvePost!: (value: object) => void;
    postMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    service.stop();
    resolvePost({ metrics: { status: "failed", retryable: true }, agent: { target_version: "stale" } });
    await Promise.resolve();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not overlap slow cycles and collects once per later interval", async () => {
    vi.useFakeTimers();
    let resolveCollection!: (value: typeof OBSERVATION) => void;
    collectMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCollection = resolve; }));
    const service = new HeartbeatService();
    service.start();
    await vi.advanceTimersByTimeAsync(600000);
    expect(collectMock).toHaveBeenCalledTimes(1);
    resolveCollection(OBSERVATION);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("keeps global single-flight through collection and resumes the latest restarted generation", async () => {
    let resolveCollection!: (value: typeof OBSERVATION) => void;
    collectMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCollection = resolve; }));
    const service = new HeartbeatService();
    service.start();
    service.stop();
    service.start();
    service.stop();
    service.start();
    resolveCollection(OBSERVATION);
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(collectMock).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("globally single-flights POST across restarts and ignores stale ACKs", async () => {
    let resolvePost!: (value: object) => void;
    postMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));
    const handler = vi.fn();
    const service = new HeartbeatService();
    service.setTargetVersionHandler(handler);
    service.start();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    service.stop();
    service.start();
    service.stop();
    service.start();
    expect(postMock).toHaveBeenCalledTimes(1);
    resolvePost({ metrics: { status: "failed", retryable: true }, agent: { target_version: "old" } });
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(handler).not.toHaveBeenCalled();
    expect(collectMock).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("start is idempotent and ping remains a bare liveness request", async () => {
    const service = new HeartbeatService();
    service.start();
    service.start();
    await flush();
    expect(collectMock).toHaveBeenCalledTimes(1);
    postSafeMock.mockResolvedValue(false);
    expect(await service.ping()).toBe(false);
    expect(postSafeMock).toHaveBeenCalledWith({ type: "alive" });
    expect(collectMock).toHaveBeenCalledTimes(1);
    service.stop();
  });
});
