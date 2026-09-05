import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, Readable } from "stream";
import { createHash } from "crypto";
import { readdirSync } from "fs";
import { tmpdir } from "os";

import { BackupService } from "../../src/services/Backup";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

const { postSafeMock } = vi.hoisted(() => ({ postSafeMock: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/Http", () => ({ httpService: { postSafe: postSafeMock } }));

// Real file I/O against os.tmpdir(); only statfs is stubbed so the disk
// pre-check is deterministic regardless of the CI runner's free space.
vi.mock("fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("fs/promises")>();
  return { ...real, statfs: vi.fn() };
});
import { statfs } from "fs/promises";

const dbOptions = {
  backupId: "backup_test_1",
  container: "db_container",
  database: "app_db",
  presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
  adminUser: "postgres",
  adminPassword: "s3cret",
};

const globalsOptions = {
  backupId: "backup_globals_1",
  container: "db_container",
  presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
  adminUser: "postgres",
  adminPassword: "s3cret",
};

const restoreDbOptions = {
  restoreId: "restore_test_1",
  container: "db_container",
  database: "app_db_copy",
  presignedUrl: "https://bucket.s3.example.com/download?sig=abc",
  adminUser: "postgres",
  adminPassword: "s3cret",
};

const volOptions = {
  backupId: "backup_vol_1",
  volume: "app_data",
  presignedUrl: "https://bucket.s3.example.com/upload?sig=abc",
};

const restoreVolOptions = {
  restoreId: "restore_vol_1",
  volume: "app_data",
  presignedUrl: "https://bucket.s3.example.com/download?sig=abc",
  overwrite: false,
};

function streamOf(content: Buffer | string | null): Readable {
  if (content === null) return Readable.from([]);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Readable.from(buf.length ? [buf] : []);
}

// Emits one chunk then errors, to exercise a dump that dies mid-stream.
function erroringStream(message: string): Readable {
  let emitted = false;
  return new Readable({
    read() {
      if (emitted) return;
      emitted = true;
      this.push(Buffer.from("partial-dump-bytes"));
      this.destroy(new Error(message));
    },
  });
}

function makeDockerStreamDump(content: Buffer | null, exitCode: number, stderr = "") {
  return {
    execCommandStream: vi.fn().mockResolvedValue({
      stdout: streamOf(content),
      stderr: streamOf(stderr),
      exitCode: vi.fn().mockResolvedValue(exitCode),
    }),
  };
}

function makeDocker(overrides: Record<string, unknown> = {}) {
  return {
    execCommandStream: vi.fn(),
    execCommandBuffered: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    runEphemeralContainer: vi.fn(),
    volumeExists: vi.fn().mockResolvedValue(false),
    createVolume: vi.fn().mockResolvedValue(undefined),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeHelper({ stdout = Buffer.alloc(0), stderr = "", waitCode = 0 }: { stdout?: Buffer; stderr?: string; waitCode?: number } = {}) {
  const stdin = new PassThrough();
  stdin.resume();
  return {
    stdin,
    stdout: streamOf(stdout),
    stderr: streamOf(stderr),
    wait: vi.fn().mockResolvedValue(waitCode),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function leftoverTempFiles(marker: string): string[] {
  return readdirSync(tmpdir()).filter(f => f.includes(marker));
}

describe("BackupService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let uploaded: Buffer[];
  let downloadBody: Buffer;

  beforeEach(() => {
    postSafeMock.mockClear();
    uploaded = [];
    downloadBody = Buffer.from("archive-payload-bytes");

    vi.mocked(statfs).mockReset();
    vi.mocked(statfs).mockResolvedValue({ bsize: 4096, bavail: 10_000_000 } as Awaited<ReturnType<typeof statfs>>);

    fetchMock = vi.fn(async (_url: string, init: { method?: string; body: AsyncIterable<Buffer> } = { body: [] as any }) => {
      if ((init.method ?? "GET") === "GET") {
        return { ok: true, status: 200, body: Readable.toWeb(Readable.from([downloadBody])) };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of init.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks));
      return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------- backupDatabase

  describe("backupDatabase", () => {
    it("stages the dump to disk, uploads it with a Content-Length, and reports backup_completed", async () => {
      const dumpContent = Buffer.from("PGDMP-fake-custom-format-archive");
      const docker = makeDockerStreamDump(dumpContent, 0);

      await new BackupService(docker as any).backupDatabase(dbOptions);

      expect(docker.execCommandStream).toHaveBeenCalledWith(
        "db_container",
        ["pg_dump", "-U", "postgres", "-h", "127.0.0.1", "--format=custom", "app_db"],
        { env: ["PGPASSWORD=s3cret"] },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, any];
      expect(url).toBe(dbOptions.presignedUrl);
      expect(init.method).toBe("PUT");
      expect(init.headers["Content-Length"]).toBe(String(dumpContent.length));
      expect(uploaded[0].equals(dumpContent)).toBe(true);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_completed",
        backupId: dbOptions.backupId,
        size_bytes: dumpContent.length,
        checksum_sha256: createHash("sha256").update(dumpContent).digest("hex"),
      });

      expect(leftoverTempFiles(dbOptions.backupId)).toEqual([]);
    });

    it("reports exec_failed and uploads nothing when the container exec cannot start", async () => {
      const docker = { execCommandStream: vi.fn().mockRejectedValue(new Error("No such container: db_container")) };

      await new BackupService(docker as any).backupDatabase(dbOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: dbOptions.backupId,
        stage: "exec_failed",
        reason: "No such container: db_container",
      });
    });

    it("reports dump_failed with the stderr reason and uploads nothing when pg_dump exits non-zero", async () => {
      const docker = makeDockerStreamDump(Buffer.from("partial"), 1, "pg_dump: error: connection to database failed");

      await new BackupService(docker as any).backupDatabase(dbOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: dbOptions.backupId,
        stage: "dump_failed",
        reason: "pg_dump: error: connection to database failed",
      });
      expect(leftoverTempFiles(dbOptions.backupId)).toEqual([]);
    });

    it("reports upload_failed with the storage response body and a bounded request, then cleans up", async () => {
      fetchMock.mockImplementation(async (_url: string, init: { body: AsyncIterable<Buffer>; signal?: AbortSignal }) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        for await (const _chunk of init.body) {
          /* drain */
        }
        return { ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" };
      });
      const docker = makeDockerStreamDump(Buffer.from("dump-bytes"), 0);

      await new BackupService(docker as any).backupDatabase(dbOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: dbOptions.backupId,
        stage: "upload_failed",
        reason: expect.stringContaining("HTTP 403 — <Error><Code>AccessDenied</Code></Error>"),
      });
      expect(leftoverTempFiles(dbOptions.backupId)).toEqual([]);
    });

    it("reports disk_precheck_failed and never execs when free space is below the floor", async () => {
      vi.mocked(statfs).mockResolvedValue({ bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof statfs>>);
      const docker = { execCommandStream: vi.fn() };

      await new BackupService(docker as any).backupDatabase(dbOptions);

      expect(docker.execCommandStream).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: dbOptions.backupId,
        stage: "disk_precheck_failed",
        reason: expect.stringContaining("Insufficient disk space"),
      });
    });
  });

  // ----------------------------------------------------------------- backupGlobals

  describe("backupGlobals", () => {
    it("runs pg_dumpall --globals-only, uploads the SQL, and reports backup_completed", async () => {
      const sql = Buffer.from("-- roles\nCREATE ROLE app WITH LOGIN PASSWORD 'x';\n");
      const docker = makeDockerStreamDump(sql, 0);

      await new BackupService(docker as any).backupGlobals(globalsOptions);

      expect(docker.execCommandStream).toHaveBeenCalledWith(
        "db_container",
        ["pg_dumpall", "-U", "postgres", "-h", "127.0.0.1", "--globals-only"],
        { env: ["PGPASSWORD=s3cret"] },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, any];
      expect(url).toBe(globalsOptions.presignedUrl);
      expect(init.method).toBe("PUT");
      expect(uploaded[0].equals(sql)).toBe(true);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_completed",
        backupId: globalsOptions.backupId,
        size_bytes: sql.length,
        checksum_sha256: createHash("sha256").update(sql).digest("hex"),
      });

      expect(leftoverTempFiles(globalsOptions.backupId)).toEqual([]);
    });

    it("reports dump_failed with the pg_dumpall stderr and uploads nothing on a non-zero exit", async () => {
      const docker = makeDockerStreamDump(Buffer.from("partial"), 1, "pg_dumpall: error: connection failed");

      await new BackupService(docker as any).backupGlobals(globalsOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: globalsOptions.backupId,
        stage: "dump_failed",
        reason: "pg_dumpall: error: connection failed",
      });
      expect(leftoverTempFiles(globalsOptions.backupId)).toEqual([]);
    });

    it("reports exec_failed and uploads nothing when the container exec cannot start", async () => {
      const docker = { execCommandStream: vi.fn().mockRejectedValue(new Error("No such container: db_container")) };

      await new BackupService(docker as any).backupGlobals(globalsOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: globalsOptions.backupId,
        stage: "exec_failed",
        reason: "No such container: db_container",
      });
    });
  });

  // --------------------------------------------------------------- restoreDatabase

  describe("restoreDatabase", () => {
    it("downloads the archive, creates the database, restores it, and reports restore_completed", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi
          .fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // collision probe: not present
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // createdb
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }), // pg_restore
      });

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      expect(fetchMock).toHaveBeenCalledWith(restoreDbOptions.presignedUrl, expect.objectContaining({ method: "GET" }));
      const commands = docker.execCommandBuffered.mock.calls.map((c: any[]) => c[1][0]);
      expect(commands).toEqual(["psql", "createdb", "pg_restore"]);
      expect(docker.execCommandBuffered.mock.calls[1][2]).toMatchObject({ env: ["PGPASSWORD=s3cret"] });

      expect(postSafeMock).toHaveBeenCalledWith({ type: "restore_completed", restoreId: restoreDbOptions.restoreId });
      expect(leftoverTempFiles(restoreDbOptions.restoreId)).toEqual([]);
    });

    it("probes for an existing database with a quoted SQL literal, not a psql variable", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi
          .fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }),
      });

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      const probeArgv = docker.execCommandBuffered.mock.calls[0][1] as string[];
      expect(probeArgv).not.toContain("-v");
      expect(probeArgv.join(" ")).not.toContain(":'db'");
      expect(probeArgv[probeArgv.length - 1]).toBe("SELECT 1 FROM pg_database WHERE datname = 'app_db_copy'");
    });

    it("aborts with a collision before downloading when the target database already exists", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi.fn().mockResolvedValue({ stdout: "1", stderr: "", exitCode: 0 }),
      });

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(docker.execCommandBuffered).toHaveBeenCalledTimes(1); // probe only, no createdb
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreDbOptions.restoreId,
        stage: "collision",
        reason: expect.stringContaining("already exists"),
      });
    });

    it("reports download_failed and never creates the database when the GET is rejected", async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 404, body: null }));
      const docker = makeDocker();

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      expect(docker.execCommandBuffered).toHaveBeenCalledTimes(1); // probe only
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreDbOptions.restoreId,
        stage: "download_failed",
        reason: expect.stringContaining("404"),
      });
      expect(leftoverTempFiles(restoreDbOptions.restoreId)).toEqual([]);
    });

    it("reports restore_failed with the pg_restore stderr when the restore command fails", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi
          .fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // probe
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // createdb
          .mockResolvedValueOnce({ stdout: "", stderr: "pg_restore: error: could not execute query", exitCode: 1 }),
      });

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreDbOptions.restoreId,
        stage: "restore_failed",
        reason: "pg_restore: error: could not execute query",
      });
      expect(leftoverTempFiles(restoreDbOptions.restoreId)).toEqual([]);
    });

    it("reports disk_precheck_failed and never probes the target when free space is below the floor", async () => {
      vi.mocked(statfs).mockResolvedValue({ bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof statfs>>);
      const docker = makeDocker();

      await new BackupService(docker as any).restoreDatabase(restoreDbOptions);

      expect(docker.execCommandBuffered).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreDbOptions.restoreId,
        stage: "disk_precheck_failed",
        reason: expect.stringContaining("Insufficient disk space"),
      });
    });
  });

  // ------------------------------------------------------ backupDatabase (mysql)

  describe("backupDatabase — mysql engine", () => {
    const mysqlDbOptions = { ...dbOptions, adminUser: "root", engine: "mysql" as const };

    it("runs mysqldump with MYSQL_PWD, uploads the dump, and reports backup_completed", async () => {
      const dump = Buffer.from("-- MySQL dump\nCREATE TABLE t (id int);\n");
      const docker = makeDockerStreamDump(dump, 0);

      await new BackupService(docker as any).backupDatabase(mysqlDbOptions);

      expect(docker.execCommandStream).toHaveBeenCalledWith(
        "db_container",
        [
          "mysqldump", "-u", "root", "-h", "127.0.0.1",
          "--single-transaction", "--routines", "--triggers", "--events", "--set-gtid-purged=OFF",
          "app_db",
        ],
        { env: ["MYSQL_PWD=s3cret"] },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, any];
      expect(url).toBe(mysqlDbOptions.presignedUrl);
      expect(init.method).toBe("PUT");
      expect(init.headers["Content-Length"]).toBe(String(dump.length));
      expect(uploaded[0].equals(dump)).toBe(true);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_completed",
        backupId: mysqlDbOptions.backupId,
        size_bytes: dump.length,
        checksum_sha256: createHash("sha256").update(dump).digest("hex"),
      });
      expect(leftoverTempFiles(mysqlDbOptions.backupId)).toEqual([]);
    });

    it("treats engine 'mariadb' the same as 'mysql'", async () => {
      const docker = makeDockerStreamDump(Buffer.from("dump"), 0);

      await new BackupService(docker as any).backupDatabase({ ...mysqlDbOptions, engine: "mariadb" });

      expect(docker.execCommandStream.mock.calls[0][1][0]).toBe("mysqldump");
    });

    it("rejects a database name outside [A-Za-z0-9_] before running mysqldump", async () => {
      const docker = makeDockerStreamDump(Buffer.from("dump"), 0);

      await new BackupService(docker as any).backupDatabase({ ...mysqlDbOptions, database: "app-db; drop" });

      expect(docker.execCommandStream).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: mysqlDbOptions.backupId,
        stage: "exec_failed",
        reason: expect.stringContaining("A-Za-z0-9_"),
      });
    });

    it("reports dump_failed with the mysqldump stderr and uploads nothing on a non-zero exit", async () => {
      const docker = makeDockerStreamDump(Buffer.from("partial"), 2, "mysqldump: Got error: 1045: Access denied for user 'root'");

      await new BackupService(docker as any).backupDatabase(mysqlDbOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: mysqlDbOptions.backupId,
        stage: "dump_failed",
        reason: "mysqldump: Got error: 1045: Access denied for user 'root'",
      });
      expect(leftoverTempFiles(mysqlDbOptions.backupId)).toEqual([]);
    });

    it("reports dump_failed and uploads nothing when the dump stream dies mid-transfer", async () => {
      const docker = {
        execCommandStream: vi.fn().mockResolvedValue({
          stdout: erroringStream("read ECONNRESET"),
          stderr: streamOf(""),
          exitCode: vi.fn().mockResolvedValue(0),
        }),
      };

      await new BackupService(docker as any).backupDatabase(mysqlDbOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: mysqlDbOptions.backupId,
        stage: "dump_failed",
        reason: expect.stringContaining("ECONNRESET"),
      });
      expect(leftoverTempFiles(mysqlDbOptions.backupId)).toEqual([]);
    });
  });

  // ----------------------------------------------------- restoreDatabase (mysql)

  describe("restoreDatabase — mysql engine", () => {
    const mysqlRestoreOptions = { ...restoreDbOptions, adminUser: "root", engine: "mysql" as const };

    it("probes information_schema, creates the database, imports the dump, and reports restore_completed", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi
          .fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // schema probe: absent
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // CREATE DATABASE
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }), // mysql import
      });

      await new BackupService(docker as any).restoreDatabase(mysqlRestoreOptions);

      expect(fetchMock).toHaveBeenCalledWith(mysqlRestoreOptions.presignedUrl, expect.objectContaining({ method: "GET" }));

      const calls = docker.execCommandBuffered.mock.calls as any[][];
      expect(calls.map(c => c[1][0])).toEqual(["mysql", "mysql", "mysql"]);

      const probeArgv = calls[0][1] as string[];
      expect(probeArgv).toContain("-N");
      expect(probeArgv[probeArgv.length - 1]).toBe(
        "SELECT SCHEMA_NAME FROM information_schema.schemata WHERE schema_name = 'app_db_copy'",
      );

      expect(calls[1][1]).toEqual(["mysql", "-u", "root", "-h", "127.0.0.1", "-e", "CREATE DATABASE `app_db_copy`"]);
      expect(calls[2][1]).toEqual(["mysql", "-u", "root", "-h", "127.0.0.1", "app_db_copy"]);
      expect(calls[2][2]).toMatchObject({ env: ["MYSQL_PWD=s3cret"], inputFile: expect.any(String) });

      expect(postSafeMock).toHaveBeenCalledWith({ type: "restore_completed", restoreId: mysqlRestoreOptions.restoreId });
      expect(leftoverTempFiles(mysqlRestoreOptions.restoreId)).toEqual([]);
    });

    it("rejects a database name outside [A-Za-z0-9_] before touching the target", async () => {
      const docker = makeDocker();

      await new BackupService(docker as any).restoreDatabase({ ...mysqlRestoreOptions, database: "a`b" });

      expect(docker.execCommandBuffered).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: mysqlRestoreOptions.restoreId,
        stage: "restore_failed",
        reason: expect.stringContaining("A-Za-z0-9_"),
      });
    });

    it("aborts with restore_failed / stage collision when information_schema already lists the database", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi.fn().mockResolvedValue({ stdout: "app_db_copy\n", stderr: "", exitCode: 0 }),
      });

      await new BackupService(docker as any).restoreDatabase(mysqlRestoreOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(docker.execCommandBuffered).toHaveBeenCalledTimes(1); // probe only, no CREATE DATABASE
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: mysqlRestoreOptions.restoreId,
        stage: "collision",
        reason: expect.stringContaining("already exists"),
      });
    });

    it("reports restore_failed with the mysql stderr when the import exits non-zero", async () => {
      const docker = makeDocker({
        execCommandBuffered: vi
          .fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // probe
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // CREATE DATABASE
          .mockResolvedValueOnce({ stdout: "", stderr: "ERROR 1064 (42000) at line 5: You have an error in your SQL syntax", exitCode: 1 }),
      });

      await new BackupService(docker as any).restoreDatabase(mysqlRestoreOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: mysqlRestoreOptions.restoreId,
        stage: "restore_failed",
        reason: "ERROR 1064 (42000) at line 5: You have an error in your SQL syntax",
      });
      expect(leftoverTempFiles(mysqlRestoreOptions.restoreId)).toEqual([]);
    });

    it("reports download_failed and never creates the database when the GET is rejected", async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 404, body: null }));
      const docker = makeDocker();

      await new BackupService(docker as any).restoreDatabase(mysqlRestoreOptions);

      expect(docker.execCommandBuffered).toHaveBeenCalledTimes(1); // probe only
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: mysqlRestoreOptions.restoreId,
        stage: "download_failed",
        reason: expect.stringContaining("404"),
      });
      expect(leftoverTempFiles(mysqlRestoreOptions.restoreId)).toEqual([]);
    });
  });

  // ----------------------------------------------------------------- backupVolume

  describe("backupVolume", () => {
    it("archives the volume through a read-only helper, uploads it, and removes the helper", async () => {
      const archive = Buffer.from("tar-gz-archive-bytes");
      const helper = makeHelper({ stdout: archive, waitCode: 0 });
      const docker = makeDocker({ runEphemeralContainer: vi.fn().mockResolvedValue(helper) });

      await new BackupService(docker as any).backupVolume(volOptions);

      expect(docker.runEphemeralContainer).toHaveBeenCalledWith({
        image: "alpine:3",
        cmd: ["sh", "-c", "tar czf - -C /data ."],
        binds: ["app_data:/data:ro"],
      });
      expect(uploaded[0].equals(archive)).toBe(true);
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_completed",
        backupId: volOptions.backupId,
        size_bytes: archive.length,
        checksum_sha256: createHash("sha256").update(archive).digest("hex"),
      });
      expect(helper.remove).toHaveBeenCalledTimes(1);
      expect(leftoverTempFiles(volOptions.backupId)).toEqual([]);
    });

    it("reports archive_failed and removes the helper when tar exits non-zero", async () => {
      const helper = makeHelper({ stdout: Buffer.from("partial"), stderr: "tar: /data: Cannot open: Permission denied", waitCode: 2 });
      const docker = makeDocker({ runEphemeralContainer: vi.fn().mockResolvedValue(helper) });

      await new BackupService(docker as any).backupVolume(volOptions);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: volOptions.backupId,
        stage: "archive_failed",
        reason: "tar: /data: Cannot open: Permission denied",
      });
      expect(helper.remove).toHaveBeenCalledTimes(1);
    });

    it("removes the helper even when the upload fails", async () => {
      fetchMock.mockImplementation(async (_url: string, init: { body: AsyncIterable<Buffer> }) => {
        for await (const _chunk of init.body) {
          /* drain */
        }
        return { ok: false, status: 500 };
      });
      const helper = makeHelper({ stdout: Buffer.from("archive"), waitCode: 0 });
      const docker = makeDocker({ runEphemeralContainer: vi.fn().mockResolvedValue(helper) });

      await new BackupService(docker as any).backupVolume(volOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: volOptions.backupId,
        stage: "upload_failed",
        reason: expect.stringContaining("500"),
      });
      expect(helper.remove).toHaveBeenCalledTimes(1);
      expect(leftoverTempFiles(volOptions.backupId)).toEqual([]);
    });

    it("reports helper_failed when the helper container cannot be created", async () => {
      const docker = makeDocker({ runEphemeralContainer: vi.fn().mockRejectedValue(new Error("no such image: alpine:3")) });

      await new BackupService(docker as any).backupVolume(volOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "backup_failed",
        backupId: volOptions.backupId,
        stage: "helper_failed",
        reason: "no such image: alpine:3",
      });
    });
  });

  // ---------------------------------------------------------------- restoreVolume

  describe("restoreVolume", () => {
    it("creates the volume, streams the archive in through a helper, and reports restore_completed", async () => {
      const helper = makeHelper({ waitCode: 0 });
      const docker = makeDocker({
        volumeExists: vi.fn().mockResolvedValue(false),
        runEphemeralContainer: vi.fn().mockResolvedValue(helper),
      });

      await new BackupService(docker as any).restoreVolume(restoreVolOptions);

      expect(docker.removeVolume).not.toHaveBeenCalled();
      expect(docker.createVolume).toHaveBeenCalledWith("app_data");
      expect(docker.runEphemeralContainer).toHaveBeenCalledWith({
        image: "alpine:3",
        cmd: ["sh", "-c", "tar xzf - -C /data"],
        binds: ["app_data:/data"],
        attachStdin: true,
      });
      expect(postSafeMock).toHaveBeenCalledWith({ type: "restore_completed", restoreId: restoreVolOptions.restoreId, overwrite: false });
      expect(helper.remove).toHaveBeenCalledTimes(1);
      expect(leftoverTempFiles(restoreVolOptions.restoreId)).toEqual([]);
    });

    it("aborts with volume_exists when the volume is present and overwrite is not set", async () => {
      const docker = makeDocker({ volumeExists: vi.fn().mockResolvedValue(true) });

      await new BackupService(docker as any).restoreVolume(restoreVolOptions);

      expect(docker.createVolume).not.toHaveBeenCalled();
      expect(docker.runEphemeralContainer).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreVolOptions.restoreId,
        stage: "volume_exists",
        reason: expect.stringContaining("already exists"),
        overwrite: false,
      });
    });

    it("recreates the volume and reports overwrite:true when the volume exists and overwrite is set", async () => {
      const helper = makeHelper({ waitCode: 0 });
      const docker = makeDocker({
        volumeExists: vi.fn().mockResolvedValue(true),
        runEphemeralContainer: vi.fn().mockResolvedValue(helper),
      });

      await new BackupService(docker as any).restoreVolume({ ...restoreVolOptions, overwrite: true });

      expect(docker.removeVolume).toHaveBeenCalledWith("app_data");
      expect(docker.createVolume).toHaveBeenCalledWith("app_data");
      expect(postSafeMock).toHaveBeenCalledWith({ type: "restore_completed", restoreId: restoreVolOptions.restoreId, overwrite: true });
      expect(helper.remove).toHaveBeenCalledTimes(1);
    });

    it("reports restore_failed and removes the helper when tar exits non-zero", async () => {
      const helper = makeHelper({ stderr: "tar: short read", waitCode: 1 });
      const docker = makeDocker({ runEphemeralContainer: vi.fn().mockResolvedValue(helper) });

      await new BackupService(docker as any).restoreVolume(restoreVolOptions);

      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreVolOptions.restoreId,
        stage: "restore_failed",
        reason: "tar: short read",
        overwrite: false,
      });
      expect(helper.remove).toHaveBeenCalledTimes(1);
      expect(leftoverTempFiles(restoreVolOptions.restoreId)).toEqual([]);
    });

    it("reports download_failed and never starts a helper when the GET is rejected", async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 404, body: null }));
      const docker = makeDocker();

      await new BackupService(docker as any).restoreVolume(restoreVolOptions);

      expect(docker.runEphemeralContainer).not.toHaveBeenCalled();
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "restore_failed",
        restoreId: restoreVolOptions.restoreId,
        stage: "download_failed",
        reason: expect.stringContaining("404"),
        overwrite: false,
      });
      expect(leftoverTempFiles(restoreVolOptions.restoreId)).toEqual([]);
    });
  });
});
