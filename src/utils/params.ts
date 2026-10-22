import type { Context } from "hono";

/**
 * Read a path parameter the route is guaranteed to define.
 *
 * Hono types `ctx.req.param()` as `string | undefined`, so narrow it in one
 * place instead of asserting at every call site.
 */
export function pathParam(ctx: Context, name: string): string {
  const value = ctx.req.param(name);
  if (value === undefined) {
    throw new Error(`Missing path parameter: ${name}`);
  }
  return value;
}
