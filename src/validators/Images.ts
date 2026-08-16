import { z } from "zod";

export const pullImageSchema = z.object({
  name: z.string(),
});

export const createImageSchema = z.object({
  name: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "name must be a GitHub repo in the form owner/repo"),
  tag: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "tag must be a git commit sha"),
  applicationId: z.string().ulid("applicationId must be a ULID"),
  deploymentId: z.string().ulid("deploymentId must be a ULID"),
  token: z.string().min(1),
  buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "build arg keys must be valid identifiers"), z.string()).optional(),
});
