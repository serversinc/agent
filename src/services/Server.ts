import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";

import { createContainerSchema, containerLogsQuerySchema } from "../validators/Containers";
import { createDeploymentSchema } from "../validators/Deployments";
import { pullImageSchema, createImageSchema } from "../validators/Images";
import { createNetworkSchema } from "../validators/Networks";
import { createVolumeSchema } from "../validators/Volumes";
import { runShellSchema, runComposeSchema, execContainerSchema } from "../validators/Shell";
import { toggleSchema, firewallPortSchema } from "../validators/Security";
import { installPackageSchema } from "../validators/Packages";
import { backupDatabaseSchema, backupGlobalsSchema, restoreDatabaseSchema, backupVolumeSchema, restoreVolumeSchema } from "../validators/Backups";

import { info } from "../utils/console";
import { runWithRequestContext } from "../utils/context";
import config from "../config";
import { jwtAuthMiddleware } from "../middleware/auth";

import type { createContainerHandlers } from "../controllers/containers";
import type { createDeploymentHandlers } from "../controllers/deployments";
import type { createImageHandlers } from "../controllers/images";
import type { createNetworkHandlers } from "../controllers/networks";
import type { createVolumeHandlers } from "../controllers/volumes";
import type { createShellHandlers } from "../controllers/shell";
import type { createSecurityHandlers } from "../controllers/security";
import type { createPackageHandlers } from "../controllers/packages";
import type { createBackupHandlers } from "../controllers/backups";

type ContainerHandlers = ReturnType<typeof createContainerHandlers>;
type DeploymentHandlers = ReturnType<typeof createDeploymentHandlers>;
type ImageHandlers = ReturnType<typeof createImageHandlers>;
type NetworkHandlers = ReturnType<typeof createNetworkHandlers>;
type VolumeHandlers = ReturnType<typeof createVolumeHandlers>;
type ShellHandlers = ReturnType<typeof createShellHandlers>;
type SecurityHandlers = ReturnType<typeof createSecurityHandlers>;
type PackageHandlers = ReturnType<typeof createPackageHandlers>;
type BackupHandlers = ReturnType<typeof createBackupHandlers>;

export function startServer(
  containerHandlers: ContainerHandlers,
  deploymentHandlers: DeploymentHandlers,
  imageHandlers: ImageHandlers,
  networkHandlers: NetworkHandlers,
  volumeHandlers: VolumeHandlers,
  shellHandlers: ShellHandlers,
  securityHandlers: SecurityHandlers,
  packageHandlers: PackageHandlers,
  backupHandlers: BackupHandlers,
  port?: number,
) {
  const app = new Hono();

  app.use(cors());
  app.use("*", jwtAuthMiddleware);

  // Request ID middleware — wrap the downstream execution so AsyncLocalStorage context propagates
  app.use("*", async (ctx, next) => {
    const requestId = ctx.req.header("x-request-id") || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return runWithRequestContext({ requestId }, async () => {
      // store request-id in Hono request context for handlers that read it
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      ctx.set("request-id", requestId);
      await next();
    });
  });

  // Containers (containerHandlers is a plain object of functions)
  app.get("/containers", containerHandlers.list);
  app.get("/containers/:id", containerHandlers.get);
  app.post("/containers", zValidator("json", createContainerSchema), containerHandlers.create);
  app.delete("/containers/:id", containerHandlers.remove);

  app.post("/deployments", zValidator("json", createDeploymentSchema), deploymentHandlers.deploy);

  // Container actions
  app.post("/containers/:id/start", containerHandlers.start);
  app.post("/containers/:id/stop", containerHandlers.stop);
  app.post("/containers/:id/restart", containerHandlers.restart);
  app.post("/containers/:id/command", containerHandlers.runCommand);
  app.get("/containers/:id/logs", zValidator("query", containerLogsQuerySchema), containerHandlers.logs);

  // Images
  app.get("/images", imageHandlers.list);
  app.get("/images/:id", imageHandlers.get);
  app.post("/images/pull", zValidator("json", pullImageSchema), imageHandlers.pull);
  app.post("/images", zValidator("json", createImageSchema), imageHandlers.build);
  app.delete("/images/:id", imageHandlers.remove);

  // Networks
  app.get("/networks", networkHandlers.list);
  app.get("/networks/:id", networkHandlers.get);
  app.post("/networks", zValidator("json", createNetworkSchema), networkHandlers.create);
  app.delete("/networks/:id", networkHandlers.remove);

  // Volumes
  app.get("/volumes", volumeHandlers.list);
  app.get("/volumes/:name", volumeHandlers.get);
  app.post("/volumes", zValidator("json", createVolumeSchema), volumeHandlers.create);
  app.delete("/volumes/:name", volumeHandlers.remove);

  // Shell
  app.post("/run-shell",      zValidator("json", runShellSchema),      shellHandlers.runShell);
  app.post("/run-compose",    zValidator("json", runComposeSchema),    shellHandlers.runCompose);
  app.post("/exec-container", zValidator("json", execContainerSchema), shellHandlers.execContainer);

  // Security
  app.get("/security",                    securityHandlers.getStatus);
  app.put("/security/root-login",         zValidator("json", toggleSchema),      securityHandlers.updateRootSshLogin);
  app.put("/security/firewall",           zValidator("json", toggleSchema),      securityHandlers.updateFirewall);
  app.get("/security/firewall/ports",     securityHandlers.listFirewallPorts);
  app.post("/security/firewall/ports",    zValidator("json", firewallPortSchema), securityHandlers.addFirewallPort);
  app.delete("/security/firewall/ports/:port", securityHandlers.removeFirewallPort);
  app.put("/security/fail2ban",           zValidator("json", toggleSchema),      securityHandlers.updateFail2ban);
  app.put("/security/auto-updates",       zValidator("json", toggleSchema),      securityHandlers.updateAutoUpdates);

  // Packages
  app.post("/packages/install", zValidator("json", installPackageSchema), packageHandlers.install);

  // Backups
  app.post("/backups/database",  zValidator("json", backupDatabaseSchema),  backupHandlers.backupDatabase);
  app.post("/backups/globals",   zValidator("json", backupGlobalsSchema),   backupHandlers.backupGlobals);
  app.post("/backups/volume",    zValidator("json", backupVolumeSchema),    backupHandlers.backupVolume);
  app.post("/restores/database", zValidator("json", restoreDatabaseSchema), backupHandlers.restoreDatabase);
  app.post("/restores/volume",   zValidator("json", restoreVolumeSchema),   backupHandlers.restoreVolume);

  serve(
    {
      port: port || config.PORT,
      fetch: app.fetch.bind(app),
    },
    data => {
      info("Hono", "Server started", { port: data.port });
    },
  );
}
