import { Context } from "hono";
import { SecurityService, SecurityServiceError } from "../services/SecurityService";
import { runSecurityChecks } from "../services/SecurityChecks";
import { handleError } from "../utils/error";

export function createSecurityHandlers(securityService: SecurityService) {
  if (!securityService) throw new Error("Security service is required");

  function respondError(ctx: Context, err: unknown, operation: string) {
    if (err instanceof SecurityServiceError) {
      return ctx.json({ error: err.message }, 400);
    }
    return handleError(ctx, err, "Security", operation);
  }

  async function getStatus(ctx: Context) {
    try {
      const checks = runSecurityChecks();
      return ctx.json({ checks });
    } catch (err) {
      return respondError(ctx, err, "get security status");
    }
  }

  async function updateRootSshLogin(ctx: Context) {
    try {
      const { enabled } = await ctx.req.json<{ enabled: boolean }>();
      return ctx.json(securityService.setRootSshLogin(enabled));
    } catch (err) {
      return respondError(ctx, err, "update root SSH login");
    }
  }

  async function updateFirewall(ctx: Context) {
    try {
      const { enabled } = await ctx.req.json<{ enabled: boolean }>();
      return ctx.json(securityService.setFirewall(enabled));
    } catch (err) {
      return respondError(ctx, err, "update firewall");
    }
  }

  async function listFirewallPorts(ctx: Context) {
    try {
      return ctx.json({ ports: securityService.listFirewallPorts() });
    } catch (err) {
      return respondError(ctx, err, "list firewall ports");
    }
  }

  async function addFirewallPort(ctx: Context) {
    try {
      const { port, protocol } = await ctx.req.json<{ port: number; protocol: "tcp" | "udp" }>();
      return ctx.json(securityService.addFirewallPort(port, protocol));
    } catch (err) {
      return respondError(ctx, err, "add firewall port");
    }
  }

  async function removeFirewallPort(ctx: Context) {
    try {
      const port = parseInt(ctx.req.param("port"), 10);
      const protocol = (ctx.req.query("protocol") as "tcp" | "udp") || "tcp";
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return ctx.json({ error: "Invalid port" }, 400);
      }
      return ctx.json(securityService.removeFirewallPort(port, protocol));
    } catch (err) {
      return respondError(ctx, err, "remove firewall port");
    }
  }

  async function updateFail2ban(ctx: Context) {
    try {
      const { enabled } = await ctx.req.json<{ enabled: boolean }>();
      return ctx.json(securityService.setFail2ban(enabled));
    } catch (err) {
      return respondError(ctx, err, "update fail2ban");
    }
  }

  async function updateAutoUpdates(ctx: Context) {
    try {
      const { enabled } = await ctx.req.json<{ enabled: boolean }>();
      return ctx.json(securityService.setAutoUpdates(enabled));
    } catch (err) {
      return respondError(ctx, err, "update auto-updates");
    }
  }

  return {
    getStatus,
    updateRootSshLogin,
    updateFirewall,
    listFirewallPorts,
    addFirewallPort,
    removeFirewallPort,
    updateFail2ban,
    updateAutoUpdates,
  };
}
