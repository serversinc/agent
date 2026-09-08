import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/config", () => ({ default: { METRICS_INTERVAL_MS: 60000 } }));

const { postSafeMock } = vi.hoisted(() => ({ postSafeMock: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/Http", () => ({ httpService: { postSafe: postSafeMock } }));

const osMock = vi.hoisted(() => ({
  cpus: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
  loadavg: vi.fn(),
  uptime: vi.fn(),
}));
vi.mock("os", () => osMock);

const fsMock = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock("fs", () => fsMock);

const cpMock = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock("child_process", () => cpMock);

import { MetricsService } from "../../src/services/MetricsService";

// Build an os.cpus()-shaped array whose aggregate idle/total times hit the given targets.
function cpusWithAggregate(idle: number, total: number, cores = 4): any {
  const perCoreIdle = idle / cores;
  const perCoreBusy = (total - idle) / cores;
  return Array.from({ length: cores }, () => ({
    model: "Test CPU",
    speed: 2400,
    times: { user: perCoreBusy, nice: 0, sys: 0, idle: perCoreIdle, irq: 0 },
  }));
}

async function collectWithSampleWindow(service: MetricsService): Promise<any> {
  const promise = (service as unknown as { collect(): Promise<any> }).collect();
  await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

describe("MetricsService.collect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    osMock.totalmem.mockReturnValue(2_000_000_000);
    osMock.freemem.mockReturnValue(200_000_000);
    osMock.loadavg.mockReturnValue([0.5, 0.4, 0.3]);
    osMock.uptime.mockReturnValue(7200);
    // Disk/network probes shell out; make them no-ops for these unit tests.
    cpMock.execSync.mockImplementation(() => {
      throw new Error("no shell in test");
    });
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (String(path) === "/proc/meminfo") {
        return "MemTotal:        1953125 kB\nMemFree:          195312 kB\nMemAvailable:      500000 kB\n";
      }
      throw new Error(`unexpected readFileSync: ${path}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports CPU utilisation as a percentage sampled across the window, not the load average", async () => {
    // Busy time over the window: idleDelta 200 of totalDelta 1000 -> 80% utilised.
    osMock.cpus
      .mockReturnValueOnce(cpusWithAggregate(1000, 2000))
      .mockReturnValue(cpusWithAggregate(1200, 3000));

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.cpu.utilisation).toBe(80);
    expect(payload.usage.cpu.cores).toBe(4);
    expect(payload.usage.cpu.load).toBe(0.5);
  });

  it("clamps CPU utilisation to 0 when the sampling window shows no elapsed CPU time", async () => {
    osMock.cpus.mockReturnValue(cpusWithAggregate(1000, 2000));

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.cpu.utilisation).toBe(0);
  });

  it("computes utilisation from partial busy time (10% busy -> 10)", async () => {
    osMock.cpus
      .mockReturnValueOnce(cpusWithAggregate(0, 0))
      .mockReturnValue(cpusWithAggregate(900, 1000));

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.cpu.utilisation).toBe(10);
  });

  it("keeps the whole-GB total/free fields and adds byte-precise fields with a cache-aware available figure", async () => {
    osMock.cpus.mockReturnValue(cpusWithAggregate(1000, 2000));
    osMock.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024 + 123_456_789);
    osMock.freemem.mockReturnValue(2 * 1024 * 1024 * 1024 + 7_000_000);

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    const totalBytes = 8 * 1024 * 1024 * 1024 + 123_456_789;
    const availableBytes = 500000 * 1024; // MemAvailable from the mocked /proc/meminfo

    // Existing GB fields are unchanged (rounded whole gigabytes).
    expect(payload.usage.memory.total).toBe(8);
    expect(payload.usage.memory.free).toBe(2);

    // New byte-precise fields.
    expect(payload.usage.memory.total_bytes).toBe(totalBytes);
    expect(payload.usage.memory.available_bytes).toBe(availableBytes);
    expect(payload.usage.memory.used_bytes).toBe(totalBytes - availableBytes);

    // available_bytes is sourced from MemAvailable (cache-aware), not from os.freemem().
    expect(payload.usage.memory.available_bytes).not.toBe(2 * 1024 * 1024 * 1024 + 7_000_000);
  });

  it("takes available_bytes from MemAvailable even when it exceeds raw free memory", async () => {
    osMock.cpus.mockReturnValue(cpusWithAggregate(1000, 2000));
    osMock.freemem.mockReturnValue(120_000_000);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (String(path) === "/proc/meminfo") {
        return "MemFree:          117187 kB\nMemAvailable:      500000 kB\n";
      }
      throw new Error(`unexpected readFileSync: ${path}`);
    });

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.memory.available_bytes).toBe(500000 * 1024);
    expect(payload.usage.memory.available_bytes).toBeGreaterThan(120_000_000);
  });

  it("falls back to raw free memory for available_bytes when /proc/meminfo is unreadable", async () => {
    osMock.cpus.mockReturnValue(cpusWithAggregate(1000, 2000));
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.memory.available_bytes).toBe(200_000_000);
    expect(payload.usage.memory.used_bytes).toBe(2_000_000_000 - 200_000_000);
  });

  it("still carries uptimeMinutes alongside the usage block", async () => {
    osMock.cpus.mockReturnValue(cpusWithAggregate(1000, 2000));

    const service = new MetricsService();
    const payload = await collectWithSampleWindow(service);

    expect(payload.usage.uptimeMinutes).toBe(120);
  });
});
