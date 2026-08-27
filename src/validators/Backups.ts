import { z } from "zod";

export const backupDatabaseSchema = z.object({
  backupId: z.string().min(1),
  container: z.string().min(1),
  database: z.string().min(1),
  presignedUrl: z.string().url(),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(1),
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
