import { createContainerHandlers } from "./controllers/containers";
import { createImageHandlers } from "./controllers/images";
import { createNetworkHandlers } from "./controllers/networks";
import { createVolumeHandlers } from "./controllers/volumes";
import { createShellHandlers } from "./controllers/shell";
import { createSecurityHandlers } from "./controllers/security";
import { createPackageHandlers } from "./controllers/packages";

import { startServer } from "./services/Server";
import { DockerService } from "./services/Docker";
import { BuildService } from "./services/BuildService";
import { ShellService } from "./services/Shell";
import { WatcherService } from "./services/Watcher";
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

watcherService.start();
heartbeatService.start();
metricsService.start();
stateCheckService.start();

const containerHandlers = createContainerHandlers(dockerService);
const imageHandlers     = createImageHandlers(dockerService, buildService);
const networkHandlers   = createNetworkHandlers(dockerService);
const volumeHandlers    = createVolumeHandlers(dockerService);
const shellHandlers     = createShellHandlers(shellService, dockerService);
const securityHandlers  = createSecurityHandlers(securityService);
const packageHandlers   = createPackageHandlers(packageService);

startServer(
  containerHandlers,
  imageHandlers,
  networkHandlers,
  volumeHandlers,
  shellHandlers,
  securityHandlers,
  packageHandlers,
  config.PORT,
);
