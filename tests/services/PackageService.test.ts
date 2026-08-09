import { describe, it, expect, vi } from "vitest";
import { PackageService } from "../../src/services/PackageService";

describe("PackageService", () => {
  it("rejects invalid package names without shelling out", async () => {
    const mockShellService = { exec: vi.fn() };
    const service = new PackageService(mockShellService as any);

    await expect(service.install("fail2ban; rm -rf /")).rejects.toThrow(/Invalid package name/);
    expect(mockShellService.exec).not.toHaveBeenCalled();
  });

  it("runs apt-get install for a valid package name", async () => {
    const mockShellService = { exec: vi.fn().mockResolvedValue({ output: "Setting up fail2ban", error: "", exitCode: 0 }) };
    const service = new PackageService(mockShellService as any);

    const result = await service.install("fail2ban");

    expect(result.exitCode).toBe(0);
    expect(mockShellService.exec).toHaveBeenCalledWith(
      expect.stringContaining("apt-get install -y --no-install-recommends fail2ban"),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("accepts package names with dots, plusses, and dashes", async () => {
    const mockShellService = { exec: vi.fn().mockResolvedValue({ output: "", error: "", exitCode: 0 }) };
    const service = new PackageService(mockShellService as any);

    await expect(service.install("g++")).resolves.toBeDefined();
  });
});
