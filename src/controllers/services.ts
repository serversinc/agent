import { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  SystemdService,
  SystemdServiceError,
  DEFAULT_JOURNAL_LINES,
  DEFAULT_JOURNAL_SINCE,
} from "../services/SystemdService";
import type { ServiceAction } from "../services/SystemdService";
import { handleError } from "../utils/error";

export function createServiceHandlers(systemdService: SystemdService) {
  if (!systemdService) throw new Error("Systemd service is required");

  // SystemdServiceError already carries the intended status (400/404/503/500),
  // so surface that rather than collapsing everything to handleError's default.
  function respondError(ctx: Context, err: unknown, operation: string) {
    if (err instanceof SystemdServiceError) {
      return ctx.json({ error: err.message }, err.statusCode as ContentfulStatusCode);
    }
    return handleError(ctx, err, "Systemd", operation);
  }

  async function list(ctx: Context) {
    try {
      return ctx.json(systemdService.listServices());
    } catch (err) {
      return respondError(ctx, err, "list services");
    }
  }

  async function action(ctx: Context) {
    try {
      const unit = ctx.req.param("unit");
      const { action: serviceAction } = await ctx.req.json<{ action: ServiceAction }>();
      return ctx.json(systemdService.performAction(unit, serviceAction));
    } catch (err) {
      return respondError(ctx, err, "perform service action");
    }
  }

  async function journal(ctx: Context) {
    try {
      const unit = ctx.req.param("unit");
      const lines = ctx.req.query("lines") ? Number(ctx.req.query("lines")) : DEFAULT_JOURNAL_LINES;
      const since = ctx.req.query("since") ?? DEFAULT_JOURNAL_SINCE;
      return ctx.json(systemdService.getJournal(unit, lines, since));
    } catch (err) {
      return respondError(ctx, err, "read service journal");
    }
  }

  return { list, action, journal };
}
