import { z } from "zod";

// Selects the dump/restore toolchain. Absent or "postgres" keeps the historical
// pg_dump/pg_restore behaviour; "mysql" and "mariadb" both use mysqldump/mysql.
export const databaseEngineSchema = z.enum(["postgres", "mysql", "mariadb"]).optional().default("postgres");

export const backupDatabaseSchema = z.object({
  backupId: z.string().min(1),
  container: z.string().min(1),
  database: z.string().min(1),
  presignedUrl: z.string().url(),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(1),
  engine: databaseEngineSchema,
});

export const backupGlobalsSchema = z.object({
  backupId: z.string().min(1),
  container: z.string().min(1),
  presignedUrl: z.string().url(),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(1),
});

export const restoreDatabaseSchema = z.object({
  restoreId: z.string().min(1),
  container: z.string().min(1),
  database: z.string().min(1),
  presignedUrl: z.string().url(),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(1),
  engine: databaseEngineSchema,
});

export const backupVolumeSchema = z.object({
  backupId: z.string().min(1),
  volume: z.string().min(1),
  presignedUrl: z.string().url(),
});

export const restoreVolumeSchema = z.object({
  restoreId: z.string().min(1),
  volume: z.string().min(1),
  presignedUrl: z.string().url(),
  overwrite: z.boolean().optional().default(false),
});
