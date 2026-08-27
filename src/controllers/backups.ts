import { Context } from "hono";
import { BackupService, BackupDatabaseOptions, BackupGlobalsOptions, RestoreDatabaseOptions, BackupVolumeOptions, RestoreVolumeOptions } from "../services/Backup";
import { info, error as logError } from "../utils/console";
import { handleError } from "../utils/error";

export function createBackupHandlers(backupService: BackupService) {
  if (!backupService) throw new Error("Backup service is required");

  async function backupDatabase(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as BackupDatabaseOptions;
      const { backupId, container, database } = options;

      info("Backup", "Database backup requested", { backupId, container, database });

      backupService.backupDatabase(options).catch(err => {
        logError("Backup", "Unhandled backup error", { backupId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "backup started", backupId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Backup", "start database backup");
    }
  }

  async function backupGlobals(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as BackupGlobalsOptions;
      const { backupId, container } = options;

      info("Backup", "Globals backup requested", { backupId, container });

      backupService.backupGlobals(options).catch(err => {
        logError("Backup", "Unhandled backup error", { backupId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "backup started", backupId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Backup", "start globals backup");
    }
  }

  async function restoreDatabase(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as RestoreDatabaseOptions;
      const { restoreId, container, database } = options;

      info("Backup", "Database restore requested", { restoreId, container, database });

      backupService.restoreDatabase(options).catch(err => {
        logError("Backup", "Unhandled restore error", { restoreId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "restore started", restoreId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Backup", "start database restore");
    }
  }

  async function backupVolume(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as BackupVolumeOptions;
      const { backupId, volume } = options;

      info("Backup", "Volume backup requested", { backupId, volume });

      backupService.backupVolume(options).catch(err => {
        logError("Backup", "Unhandled backup error", { backupId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "backup started", backupId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Backup", "start volume backup");
    }
  }

  async function restoreVolume(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as RestoreVolumeOptions;
      const { restoreId, volume } = options;

      info("Backup", "Volume restore requested", { restoreId, volume });

      backupService.restoreVolume(options).catch(err => {
        logError("Backup", "Unhandled restore error", { restoreId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "restore started", restoreId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Backup", "start volume restore");
    }
  }

  return { backupDatabase, backupGlobals, restoreDatabase, backupVolume, restoreVolume };
}
