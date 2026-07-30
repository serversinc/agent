import { z } from "zod";

export const runShellSchema = z.object({
  command: z.string().min(1),
});

export const runComposeSchema = z.object({
  project: z.string().min(1),
  compose: z.string().min(1),
  env: z.record(z.string()).optional(),
});

export const execContainerSchema = z.object({
  container: z.string().min(1),
  command: z.string().min(1),
});
