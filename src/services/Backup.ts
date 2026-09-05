import { createReadStream } from "fs";
import { pipeline } from "stream/promises";

import { DockerService } from "./Docker";
import { httpService } from "./Http";
import { error, info } from "../utils/console";
import { assertDiskSpace, downloadFile, fileSize, hashFile, stageToFile, uploadFile, withTempFile } from "../utils/storage";

// Which dump/restore toolchain to drive. Absent or "postgres" preserves the
// historical pg_dump/pg_restore path; "mysql" and "mariadb" share the
// mysqldump/mysql client and are treated identically.
export type DatabaseEngine = "postgres" | "mysql" | "mariadb";

function isMysqlEngine(engine?: DatabaseEngine): boolean {
  return engine === "mysql" || engine === "mariadb";
}

// Core validates logical database names before dispatch; re-checked here so a
// malformed name can never reach an interpolated SQL statement or be read as a
// leading-dash option by mysqldump/mysql.
const VALID_DATABASE_NAME = /^[A-Za-z0-9_]+$/;

export interface BackupDatabaseOptions {
  backupId: string;
  container: string;
  database: string;
  presignedUrl: string;
  adminUser: string;
  adminPassword: string;
  engine?: DatabaseEngine;
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
  engine?: DatabaseEngine;
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
    const { backupId, container, database, presignedUrl, adminUser, adminPassword, engine } = options;

    if (isMysqlEngine(engine)) {
      if (!VALID_DATABASE_NAME.test(database)) {
        return this.failBackup(backupId, "exec_failed", "database name must match ^[A-Za-z0-9_]+$");
      }

      // The password goes in MYSQL_PWD (the mysqldump equivalent of PGPASSWORD)
      // so it never lands on the container's process argv. -h 127.0.0.1 forces a
      // TCP + password auth rather than a local-socket root connection.
      // --set-gtid-purged=OFF keeps a GTID-enabled source from emitting a
      // SET @@GLOBAL.GTID_PURGED the fresh target would reject.
      await this.streamDump({
        backupId,
        container,
        presignedUrl,
        cmd: [
          "mysqldump", "-u", adminUser, "-h", "127.0.0.1",
          "--single-transaction", "--routines", "--triggers", "--events", "--set-gtid-purged=OFF",
          database,
        ],
        env: [`MYSQL_PWD=${adminPassword}`],
        tmpName: `backup-${backupId}.sql`,
        logLabel: "Database backup completed",
        logMeta: { backupId, container, database, engine },
      });
      return;
    }

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
      logMeta: { backupId, container, database, engine: engine ?? "postgres" },
    });
  }

  // Fire-and-forget: dumps cluster-wide globals (roles, their passwords, and
  // tablespaces) via `pg_dumpall --globals-only` — the parts a per-database
  // pg_dump does not capture — as plain SQL, and uploads it. Same event contract
  // as backupDatabase.
  //
  // Postgres only: MySQL/MariaDB have no globals dump — grants there are
  // per-object and captured by the per-database mysqldump — so v1 has no MySQL
  // branch here.
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
      logMeta: { backupId, container, engine: "postgres" },
    });
  }

  // Shared pipeline for the logical-dump backup routes (pg_dump, pg_dumpall,
  // mysqldump): exec the dump, stream it straight to a temp file, checksum it,
  // upload it, emit the terminal event. Temp file is always cleaned up.
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
  // Dispatches on `engine`: absent/"postgres" -> pg_restore, "mysql"/"mariadb" ->
  // the mysql client.
  async restoreDatabase(options: RestoreDatabaseOptions): Promise<void> {
    if (isMysqlEngine(options.engine)) {
      return this.restoreMysqlDatabase(options);
    }
    return this.restorePostgresDatabase(options);
  }

  private async restorePostgresDatabase(options: RestoreDatabaseOptions): Promise<void> {
    const { restoreId, container, database, presignedUrl, adminUser, adminPassword } = options;
    const env = [`PGPASSWORD=${adminPassword}`];

    // A terminal event is sent from exactly one place; `settled` stops the outer
    // catch from emitting a second restore_failed after an inner branch already
    // reported the outcome.
    let settled = false;
    const fail = (stage: RestoreStage, reason: string): Promise<void> => {
      settled = true;
      return this.failRestore(restoreId, stage, reason);
    };

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return fail("disk_precheck_failed", (err as Error).message);
      }

      // Collision check first — never touch an existing database.
      let exists: boolean;
      try {
        exists = await this.databaseExists(container, database, adminUser, env);
      } catch (err) {
        return fail("restore_failed", (err as Error).message);
      }
      if (exists) {
        return fail("collision", `database "${database}" already exists on the target`);
      }

      await withTempFile(`restore-${restoreId}.dump`, async path => {
        try {
          await downloadFile(presignedUrl, path);
        } catch (err) {
          return fail("download_failed", (err as Error).message);
        }

        const create = await this.dockerService.execCommandBuffered(container, ["createdb", "-U", adminUser, "-h", "127.0.0.1", database], { env });
        if (create.exitCode !== 0) {
          return fail("restore_failed", create.stderr.trim() || `createdb exited with code ${create.exitCode}`);
        }

        const restore = await this.dockerService.execCommandBuffered(
          container,
          ["pg_restore", "-U", adminUser, "-h", "127.0.0.1", "-d", database, "--no-owner", "--no-acl"],
          { env, inputFile: path },
        );
        if (restore.exitCode !== 0) {
          return fail("restore_failed", restore.stderr.trim() || `pg_restore exited with code ${restore.exitCode}`);
        }

        settled = true;
        info(this.name, "Database restore completed", { restoreId, container, database, engine: options.engine ?? "postgres" });
        await httpService.postSafe({ type: "restore_completed", restoreId });
      });
    } catch (err) {
      if (!settled) await this.failRestore(restoreId, "restore_failed", (err as Error).message);
    }
  }

  // MySQL/MariaDB restore: probe information_schema for a name collision, create
  // the target schema, then feed the plain-SQL dump into the mysql client on
  // stdin. The password rides in MYSQL_PWD so it stays off the process argv.
  private async restoreMysqlDatabase(options: RestoreDatabaseOptions): Promise<void> {
    const { restoreId, container, database, presignedUrl, adminUser, adminPassword } = options;
    const env = [`MYSQL_PWD=${adminPassword}`];

    // A terminal event is sent from exactly one place; `settled` stops the outer
    // catch from emitting a second restore_failed after an inner branch already
    // reported the outcome.
    let settled = false;
    const fail = (stage: RestoreStage, reason: string): Promise<void> => {
      settled = true;
      return this.failRestore(restoreId, stage, reason);
    };

    if (!VALID_DATABASE_NAME.test(database)) {
      return fail("restore_failed", "database name must match ^[A-Za-z0-9_]+$");
    }

    try {
      try {
        await assertDiskSpace();
      } catch (err) {
        return fail("disk_precheck_failed", (err as Error).message);
      }

      let exists: boolean;
      try {
        exists = await this.mysqlSchemaExists(container, database, adminUser, env);
      } catch (err) {
        return fail("restore_failed", (err as Error).message);
      }
      if (exists) {
        return fail("collision", `database "${database}" already exists on the target`);
      }

      await withTempFile(`restore-${restoreId}.sql`, async path => {
        try {
          await downloadFile(presignedUrl, path);
        } catch (err) {
          return fail("download_failed", (err as Error).message);
        }

        // Backtick-quoted identifier, internal backticks doubled.
        const ident = `\`${database.replace(/`/g, "``")}\``;
        const create = await this.dockerService.execCommandBuffered(
          container,
          ["mysql", "-u", adminUser, "-h", "127.0.0.1", "-e", `CREATE DATABASE ${ident}`],
          { env },
        );
        if (create.exitCode !== 0) {
          return fail("restore_failed", create.stderr.trim() || `mysql exited with code ${create.exitCode}`);
        }

        const restore = await this.dockerService.execCommandBuffered(
          container,
          ["mysql", "-u", adminUser, "-h", "127.0.0.1", database],
          { env, inputFile: path },
        );
        if (restore.exitCode !== 0) {
          return fail("restore_failed", restore.stderr.trim() || `mysql exited with code ${restore.exitCode}`);
        }

        settled = true;
        info(this.name, "Database restore completed", { restoreId, container, database, engine: options.engine });
        await httpService.postSafe({ type: "restore_completed", restoreId });
      });
    } catch (err) {
      if (!settled) await this.failRestore(restoreId, "restore_failed", (err as Error).message);
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

  private async mysqlSchemaExists(container: string, database: string, user: string, env: string[]): Promise<boolean> {
    // Name embedded as a quoted SQL literal (single quotes doubled). -N -B strips
    // the column header and box drawing so a hit is just the bare schema name.
    const literal = `'${database.replace(/'/g, "''")}'`;
    const res = await this.dockerService.execCommandBuffered(
      container,
      ["mysql", "-u", user, "-h", "127.0.0.1", "-N", "-B", "-e", `SELECT SCHEMA_NAME FROM information_schema.schemata WHERE schema_name = ${literal}`],
      { env },
    );

    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `mysql exited with code ${res.exitCode}`);
    }

    return res.stdout.trim() !== "";
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
