import { createReadStream } from "fs";
import { pipeline } from "stream/promises";

import { DockerService } from "./Docker";
import { httpService } from "./Http";
import { error, info } from "../utils/console";
import { assertDiskSpace, downloadFile, fileSize, hashFile, stageToFile, uploadFile, withTempFile } from "../utils/storage";

export interface BackupDatabaseOptions {
  backupId: string;
  container: string;
  database: string;
  presignedUrl: string;
  adminUser: string;
  adminPassword: string;
}

export interface BackupGlobalsOptions {
  backupId: string;
  container: string;
  presignedUrl: string;
  adminUser: string;
  adminPassword: string;
}

export interface RestoreDatabaseOptions {
  restoreId: string;
  container: string;
  database: string; // target logical database name
  presignedUrl: string;
  adminUser: string;
  adminPassword: string;
}

export interface BackupVolumeOptions {
  backupId: string;
  volume: string;
  presignedUrl: string;
}

export interface RestoreVolumeOptions {
  restoreId: string;
  volume: string;
  presignedUrl: string;
  overwrite: boolean;
}

type BackupStage = "disk_precheck_failed" | "exec_failed" | "dump_failed" | "helper_failed" | "archive_failed" | "upload_failed";
type RestoreStage = "disk_precheck_failed" | "download_failed" | "collision" | "volume_exists" | "helper_failed" | "restore_failed";

// busybox tar + sh; small, and its tar handles gzip via -z.
const HELPER_IMAGE = "alpine:3";

export class BackupService {
  public readonly name = "Backup";

  constructor(private readonly dockerService: DockerService) {}

  // Fire-and-forget: dumps a single logical database (pg_dump custom format) to a
  // local temp file, uploads it to the pre-signed URL, then reports the outcome
  // to CORE_URL. Never throws — failures are a `backup_failed` event instead.
  async backupDatabase(options: BackupDatabaseOptions): Promise<void> {
    const { backupId, container, database, presignedUrl, adminUser, adminPassword } = options;

    // -h 127.0.0.1 forces a TCP + password connection so pg_dump authenticates as
    // the admin role rather than falling back to (failing) peer auth as root.
    await this.streamDump({
      backupId,
      container,
      presignedUrl,
      cmd: ["pg_dump", "-U", adminUser, "-h", "127.0.0.1", "--format=custom", database],
      env: [`PGPASSWORD=${adminPassword}`],
      tmpName: `backup-${backupId}.dump`,
      logLabel: "Database backup completed",
      logMeta: { backupId, container, database },
    });
  }

  // Fire-and-forget: dumps cluster-wide globals (roles, their passwords, and
  // tablespaces) via `pg_dumpall --globals-only` — the parts a per-database
  // pg_dump does not capture — as plain SQL, and uploads it. Same event contract
  // as backupDatabase.
  async backupGlobals(options: BackupGlobalsOptions): Promise<void> {
    const { backupId, container, presignedUrl, adminUser, adminPassword } = options;

    await this.streamDump({
      backupId,
      container,
      presignedUrl,
      cmd: ["pg_dumpall", "-U", adminUser, "-h", "127.0.0.1", "--globals-only"],
      env: [`PGPASSWORD=${adminPassword}`],
      tmpName: `backup-${backupId}.sql`,
      logLabel: "Globals backup completed",
      logMeta: { backupId, container },
    });
  }

  // Shared pipeline for the pg_dump / pg_dumpall backup routes: exec the dump,
  // stream it straight to a temp file, checksum it, upload it, emit the terminal
  // event. Temp file is always cleaned up.
  private async streamDump(params: {
    backupId: string;
    container: string;
    presignedUrl: string;
    cmd: string[];
    env: string[];
    tmpName: string;
    logLabel: string;
    logMeta: Record<string, unknown>;
  }): Promise<void> {
    const { backupId, container, presignedUrl, cmd, env, tmpName, logLabel, logMeta } = params;

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return this.failBackup(backupId, "disk_precheck_failed", (err as Error).message);
      }

      let dump: Awaited<ReturnType<DockerService["execCommandStream"]>>;
      try {
        dump = await this.dockerService.execCommandStream(container, cmd, { env });
      } catch (err) {
        return this.failBackup(backupId, "exec_failed", (err as Error).message);
      }

      const stderrChunks: Buffer[] = [];
      dump.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      await withTempFile(tmpName, async path => {
        try {
          await stageToFile(dump.stdout, path);
        } catch (err) {
          return this.failBackup(backupId, "dump_failed", (err as Error).message);
        }

        const code = await dump.exitCode();
        if (code !== 0) {
          const reason = Buffer.concat(stderrChunks).toString("utf-8").trim() || `${cmd[0]} exited with code ${code}`;
          return this.failBackup(backupId, "dump_failed", reason);
        }

        const size = await fileSize(path);
        const checksum = await hashFile(path);

        try {
          await uploadFile(presignedUrl, path);
        } catch (err) {
          return this.failBackup(backupId, "upload_failed", (err as Error).message);
        }

        info(this.name, logLabel, { ...logMeta, sizeBytes: size });
        await httpService.postSafe({ type: "backup_completed", backupId, size_bytes: size, checksum_sha256: checksum });
      });
    } catch (err) {
      await this.failBackup(backupId, "upload_failed", (err as Error).message);
    }
  }

  // Restores a database archive onto a target container under `database`. Aborts
  // before writing anything if that name already exists (collision). Never throws.
  async restoreDatabase(options: RestoreDatabaseOptions): Promise<void> {
    const { restoreId, container, database, presignedUrl, adminUser, adminPassword } = options;
    const env = [`PGPASSWORD=${adminPassword}`];

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return this.failRestore(restoreId, "disk_precheck_failed", (err as Error).message);
      }

      // Collision check first — never touch an existing database.
      let exists: boolean;
      try {
        exists = await this.databaseExists(container, database, adminUser, env);
      } catch (err) {
        return this.failRestore(restoreId, "restore_failed", (err as Error).message);
      }
      if (exists) {
        return this.failRestore(restoreId, "collision", `database "${database}" already exists on the target`);
      }

      await withTempFile(`restore-${restoreId}.dump`, async path => {
        try {
          await downloadFile(presignedUrl, path);
        } catch (err) {
          return this.failRestore(restoreId, "download_failed", (err as Error).message);
        }

        const create = await this.dockerService.execCommandBuffered(container, ["createdb", "-U", adminUser, "-h", "127.0.0.1", database], { env });
        if (create.exitCode !== 0) {
          return this.failRestore(restoreId, "restore_failed", create.stderr.trim() || `createdb exited with code ${create.exitCode}`);
        }

        const restore = await this.dockerService.execCommandBuffered(
          container,
          ["pg_restore", "-U", adminUser, "-h", "127.0.0.1", "-d", database, "--no-owner", "--no-acl"],
          { env, inputFile: path },
        );
        if (restore.exitCode !== 0) {
          return this.failRestore(restoreId, "restore_failed", restore.stderr.trim() || `pg_restore exited with code ${restore.exitCode}`);
        }

        info(this.name, "Database restore completed", { restoreId, container, database });
        await httpService.postSafe({ type: "restore_completed", restoreId });
      });
    } catch (err) {
      await this.failRestore(restoreId, "restore_failed", (err as Error).message);
    }
  }

  // Archives a named volume via a throwaway helper container and uploads it.
  async backupVolume(options: BackupVolumeOptions): Promise<void> {
    const { backupId, volume, presignedUrl } = options;

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return this.failBackup(backupId, "disk_precheck_failed", (err as Error).message);
      }

      let helper: Awaited<ReturnType<DockerService["runEphemeralContainer"]>>;
      try {
        helper = await this.dockerService.runEphemeralContainer({
          image: HELPER_IMAGE,
          cmd: ["sh", "-c", "tar czf - -C /data ."],
          binds: [`${volume}:/data:ro`],
        });
      } catch (err) {
        return this.failBackup(backupId, "helper_failed", (err as Error).message);
      }

      try {
        const stderrChunks: Buffer[] = [];
        helper.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        await withTempFile(`backup-${backupId}.tar.gz`, async path => {
          try {
            await stageToFile(helper.stdout, path);
          } catch (err) {
            return this.failBackup(backupId, "archive_failed", (err as Error).message);
          }

          const code = await helper.wait();
          if (code !== 0) {
            const reason = Buffer.concat(stderrChunks).toString("utf-8").trim() || `tar exited with code ${code}`;
            return this.failBackup(backupId, "archive_failed", reason);
          }

          const size = await fileSize(path);
          const checksum = await hashFile(path);

          try {
            await uploadFile(presignedUrl, path);
          } catch (err) {
            return this.failBackup(backupId, "upload_failed", (err as Error).message);
          }

          info(this.name, "Volume backup completed", { backupId, volume, sizeBytes: size });
          await httpService.postSafe({ type: "backup_completed", backupId, size_bytes: size, checksum_sha256: checksum });
        });
      } finally {
        await helper.remove();
      }
    } catch (err) {
      await this.failBackup(backupId, "upload_failed", (err as Error).message);
    }
  }

  // Restores a volume archive into a named volume. An existing volume aborts
  // unless overwrite is set; the outcome event always carries `overwrite`.
  async restoreVolume(options: RestoreVolumeOptions): Promise<void> {
    const { restoreId, volume, presignedUrl, overwrite } = options;

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return this.failRestore(restoreId, "disk_precheck_failed", (err as Error).message, { overwrite });
      }

      let exists: boolean;
      try {
        exists = await this.dockerService.volumeExists(volume);
      } catch (err) {
        return this.failRestore(restoreId, "restore_failed", (err as Error).message, { overwrite });
      }
      if (exists && !overwrite) {
        return this.failRestore(restoreId, "volume_exists", `volume "${volume}" already exists on the target`, { overwrite });
      }

      try {
        if (exists) {
          await this.dockerService.removeVolume(volume);
        }
        await this.dockerService.createVolume(volume);
      } catch (err) {
        return this.failRestore(restoreId, "restore_failed", (err as Error).message, { overwrite });
      }

      await withTempFile(`restore-${restoreId}.tar.gz`, async path => {
        try {
          await downloadFile(presignedUrl, path);
        } catch (err) {
          return this.failRestore(restoreId, "download_failed", (err as Error).message, { overwrite });
        }

        let helper: Awaited<ReturnType<DockerService["runEphemeralContainer"]>>;
        try {
          helper = await this.dockerService.runEphemeralContainer({
            image: HELPER_IMAGE,
            cmd: ["sh", "-c", "tar xzf - -C /data"],
            binds: [`${volume}:/data`],
            attachStdin: true,
          });
        } catch (err) {
          return this.failRestore(restoreId, "helper_failed", (err as Error).message, { overwrite });
        }

        try {
          const stderrChunks: Buffer[] = [];
          helper.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

          await pipeline(createReadStream(path), helper.stdin);

          const code = await helper.wait();
          if (code !== 0) {
            const reason = Buffer.concat(stderrChunks).toString("utf-8").trim() || `tar exited with code ${code}`;
            return this.failRestore(restoreId, "restore_failed", reason, { overwrite });
          }

          info(this.name, "Volume restore completed", { restoreId, volume, overwrite });
          await httpService.postSafe({ type: "restore_completed", restoreId, overwrite });
        } finally {
          await helper.remove();
        }
      });
    } catch (err) {
      await this.failRestore(restoreId, "restore_failed", (err as Error).message, { overwrite });
    }
  }

  private async databaseExists(container: string, database: string, user: string, env: string[]): Promise<boolean> {
    // psql does not expand `:'var'` inside a -c string, so the name is embedded
    // as a quoted SQL literal (single quotes doubled) rather than a variable.
    const literal = `'${database.replace(/'/g, "''")}'`;
    const res = await this.dockerService.execCommandBuffered(
      container,
      ["psql", "-U", user, "-h", "127.0.0.1", "-tAc", `SELECT 1 FROM pg_database WHERE datname = ${literal}`],
      { env },
    );

    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `psql exited with code ${res.exitCode}`);
    }

    return res.stdout.trim() === "1";
  }

  private async failBackup(backupId: string, stage: BackupStage, reason: string): Promise<void> {
    error(this.name, "Backup failed", { backupId, stage, reason });
    await httpService.postSafe({ type: "backup_failed", backupId, stage, reason });
  }

  private async failRestore(restoreId: string, stage: RestoreStage, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    error(this.name, "Restore failed", { restoreId, stage, reason, ...extra });
    await httpService.postSafe({ type: "restore_failed", restoreId, stage, reason, ...extra });
  }
}
