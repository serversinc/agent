import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createBackupHandlers } from "../../src/controllers/backups";
import { makeApp } from "../helpers/makeApp";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Backup Handlers", () => {
  let server: import("http").Server;
  let mockBackupService: any;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockBackupService = {
      backupDatabase: vi.fn().mockResolvedValue(undefined),
      backupGlobals: vi.fn().mockResolvedValue(undefined),
      restoreDatabase: vi.fn().mockResolvedValue(undefined),
      backupVolume: vi.fn().mockResolvedValue(undefined),
      restoreVolume: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = createBackupHandlers(mockBackupService);
    const s = await makeApp(
      app => {
        app.post("/backups/database", handlers.backupDatabase);
        app.post("/backups/globals", handlers.backupGlobals);
        app.post("/backups/volume", handlers.backupVolume);
        app.post("/restores/database", handlers.restoreDatabase);
        app.post("/restores/volume", handlers.restoreVolume);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  describe("POST /backups/database", () => {
    const payload = {
      backupId: "backup_1",
      container: "db_container",
      database: "app_db",
      presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
      adminUser: "postgres",
      adminPassword: "s3cret",
    };

    it("returns 202 immediately and starts the backup asynchronously", async () => {
      const response = await request(server).post("/backups/database").send(payload);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ success: true, backupId: "backup_1" });
      expect(mockBackupService.backupDatabase).toHaveBeenCalledWith(payload);
    });

    it("returns 500 without starting a backup if the request body cannot be parsed", async () => {
      const response = await request(server).post("/backups/database").set("Content-Type", "application/json").send("not json");

      expect(response.status).toBe(500);
      expect(mockBackupService.backupDatabase).not.toHaveBeenCalled();
    });

    it("still responds 202 even if the fire-and-forget backup rejects asynchronously", async () => {
      mockBackupService.backupDatabase.mockRejectedValue(new Error("boom"));

      const response = await request(server).post("/backups/database").send(payload);

      expect(response.status).toBe(202);
    });
  });

  describe("POST /restores/database", () => {
    const payload = {
      restoreId: "restore_1",
      container: "db_container",
      database: "app_db_copy",
      presignedUrl: "https://bucket.s3.example.com/download?sig=abc",
      adminUser: "postgres",
      adminPassword: "s3cret",
    };

    it("returns 202 and starts the restore asynchronously", async () => {
      const response = await request(server).post("/restores/database").send(payload);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ success: true, restoreId: "restore_1" });
      expect(mockBackupService.restoreDatabase).toHaveBeenCalledWith(payload);
    });

    it("returns 500 without starting a restore if the body cannot be parsed", async () => {
      const response = await request(server).post("/restores/database").set("Content-Type", "application/json").send("nope");

      expect(response.status).toBe(500);
      expect(mockBackupService.restoreDatabase).not.toHaveBeenCalled();
    });
  });

  describe("POST /backups/globals", () => {
    const payload = {
      backupId: "backup_g1",
      container: "db_container",
      presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
      adminUser: "postgres",
      adminPassword: "s3cret",
    };

    it("returns 202 and starts the globals backup asynchronously", async () => {
      const response = await request(server).post("/backups/globals").send(payload);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ success: true, backupId: "backup_g1" });
      expect(mockBackupService.backupGlobals).toHaveBeenCalledWith(payload);
    });

    it("returns 500 without starting a backup if the body cannot be parsed", async () => {
      const response = await request(server).post("/backups/globals").set("Content-Type", "application/json").send("nope");

      expect(response.status).toBe(500);
      expect(mockBackupService.backupGlobals).not.toHaveBeenCalled();
    });
  });

  describe("POST /backups/volume", () => {
    const payload = {
      backupId: "backup_v1",
      volume: "app_data",
      presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
    };

    it("returns 202 and starts the volume backup asynchronously", async () => {
      const response = await request(server).post("/backups/volume").send(payload);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ success: true, backupId: "backup_v1" });
      expect(mockBackupService.backupVolume).toHaveBeenCalledWith(payload);
    });
  });

  describe("POST /restores/volume", () => {
    const payload = {
      restoreId: "restore_v1",
      volume: "app_data",
      presignedUrl: "https://bucket.s3.example.com/download?sig=abc",
      overwrite: true,
    };

    it("returns 202 and starts the volume restore asynchronously", async () => {
      const response = await request(server).post("/restores/volume").send(payload);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ success: true, restoreId: "restore_v1" });
      expect(mockBackupService.restoreVolume).toHaveBeenCalledWith(payload);
    });
  });
});
