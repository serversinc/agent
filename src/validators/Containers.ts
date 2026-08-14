import { z } from "zod";

/**
 * Schema for creating a container.
 * @example
 * {
 *   "name": "my-container",
 *   "image": "nginx:latest",
 *   "hostConfig": {
 *     "NetworkMode": "bridge",
 *     "PortBindings": {
 *       "80/tcp": [{ "HostPort": "8080" }]
 *     },
 *     "Binds": ["/host/path:/container/path"]
 *   },
 *   "networks": ["agent"],
 *   "environment": ["ENV_VAR=value"],
 *   "start": true
 * }
 */
export const createContainerSchema = z.object({
  name: z.string(),
  environment: z.array(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  image: z.string(),
  hostConfig: z.object({
    NetworkMode: z.string().optional(),
    PortBindings: z.record(z.array(z.object({ HostPort: z.string() }))).optional(),
    AutoRemove: z.boolean().optional(),
    Binds: z.array(z.string()).optional(),
  }),
  command: z.array(z.string()).optional(),
  entrypoint: z.string().optional(),
  workingdir: z.string().optional(),
  start: z.boolean().optional(),
  labels: z.record(z.string()).optional(),
  networks: z.array(z.string()),
  restartPolicy: z
    .object({
      Name: z.string().optional(),
      MaximumRetryCount: z.number().optional(),
    })
    .optional(),
});

/**
 * Schema for GET /containers/:id/logs query params.
 *
 * Query values arrive as strings, so booleans are validated against the literal "true"/"false"
 * rather than `z.coerce.boolean()` — coercion treats any non-empty string (including "false") as
 * truthy, which would silently accept typos like `?follow=nope` as `true`.
 */
const booleanQueryParam = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform(value => (value === undefined ? defaultValue : value === "true"));

export const containerLogsQuerySchema = z.object({
  follow: booleanQueryParam(false),
  tail: z.coerce.number().int().min(1).max(10_000).optional(),
  since: z.coerce.number().int().min(0).optional(),
  timestamps: booleanQueryParam(false),
  stdout: booleanQueryParam(true),
  stderr: booleanQueryParam(true),
});
