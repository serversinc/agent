import { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { error as logError } from "./console";

export function handleError(ctx: Context, err: unknown, resource: string, operation: string, meta?: Record<string, unknown>) {
  const error = err as Error & { statusCode?: number };
  logError(resource, `Failed to ${operation}`, { error: error.message, ...meta });

  // Prefer a status the Docker daemon already assigned (e.g. 409 when an image
  // is still referenced by a container) so callers can tell "in use" apart
  // from a genuine failure.
  const daemonStatus =
    typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : undefined;

  const fallbackStatus = typeof error.message === "string" && error.message.toLowerCase().includes("not found") ? 404 : 500;

  const statusCode = (daemonStatus ?? fallbackStatus) as ContentfulStatusCode;

  return ctx.json({ error: error.message }, statusCode);
}
