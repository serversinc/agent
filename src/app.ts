import { createContainerHandlers } from "./controllers/containers";
import { createDeploymentHandlers } from "./controllers/deployments";
import { createImageHandlers } from "./controllers/images";
import { createNetworkHandlers } from "./controllers/networks";
import { createVolumeHandlers } from "./controllers/volumes";
import { createShellHandlers } from "./controllers/shell";
import { createSecurityHandlers } from "./controllers/security";
import { createPackageHandlers } from "./controllers/packages";
import { createBackupHandlers } from "./controllers/backups";

import { startServer } from "./services/Server";
import { DockerService } from "./services/Docker";
import { DeployService } from "./services/Deploy";
import { BuildService } from "./services/BuildService";
import { ShellService } from "./services/Shell";
import { WatcherService } from "./services/Watcher";
import { BackupService } from "./services/Backup";
import { heartbeatService } from "./services/HeartbeatService";
import { metricsService } from "./services/MetricsService";
import { stateCheckService } from "./services/StateCheckService";
import { securityService } from "./services/SecurityService";
import { packageService } from "./services/PackageService";

import config from "./config";

const dockerService  = new DockerService(config.DOCKER_SOCKET);
const buildService   = new BuildService(dockerService);
const shellService   = new ShellService();
const watcherService = new WatcherService(dockerService);
const backupService  = new BackupService(dockerService);
const deployService  = new DeployService(dockerService);

watcherService.start();
heartbeatService.start();
metricsService.start();
stateCheckService.start();

const containerHandlers  = createContainerHandlers(dockerService);
const deploymentHandlers = createDeploymentHandlers(deployService);
const imageHandlers      = createImageHandlers(dockerService, buildService);
const networkHandlers    = createNetworkHandlers(dockerService);
const volumeHandlers     = createVolumeHandlers(dockerService);
const shellHandlers      = createShellHandlers(shellService, dockerService);
const securityHandlers   = createSecurityHandlers(securityService);
const packageHandlers    = createPackageHandlers(packageService);
const backupHandlers     = createBackupHandlers(backupService);

startServer(
  containerHandlers,
  deploymentHandlers,
  imageHandlers,
  networkHandlers,
  volumeHandlers,
  shellHandlers,
  securityHandlers,
  packageHandlers,
  backupHandlers,
  config.PORT,
);
