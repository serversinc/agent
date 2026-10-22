import { describe, it, expect, beforeEach, vi } from "vitest";

const { postSafe, refreshOsUpdates, runSecurityChecks } = vi.hoisted(() => ({
  postSafe: vi.fn(),
  refreshOsUpdates: vi.fn(),
  runSecurityChecks: vi.fn(),
}));

vi.mock("../../src/services/Http", () => ({ httpService: { postSafe } }));
vi.mock("../../src/services/SecurityChecks", () => ({ refreshOsUpdates, runSecurityChecks }));
vi.mock("../../src/config", () => ({ default: { STATE_CHECK_INTERVAL_MS: 86400000 } }));
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), warn: vi.fn() }));

import { StateCheckService } from "../../src/services/StateCheckService";

describe("StateCheckService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postSafe.mockResolvedValue(true);
  });

  it("refreshes OS updates before it collects and sends the checks", async () => {
    const order: string[] = [];
    refreshOsUpdates.mockImplementation(async () => {
      order.push("refresh");
    });
    runSecurityChecks.mockImplementation(() => {
      order.push("collect");
      return [{ check_key: "os_updates", status: "bad", detail: { total: 3, security: 2 } }];
    });

    const service = new StateCheckService();
    service.start();
    await vi.waitFor(() => expect(postSafe).toHaveBeenCalledTimes(1));
    service.stop();

    expect(order).toEqual(["refresh", "collect"]);
    expect(postSafe).toHaveBeenCalledWith({
      type: "state_check",
      checks: [{ check_key: "os_updates", status: "bad", detail: { total: 3, security: 2 } }],
    });
  });
});
