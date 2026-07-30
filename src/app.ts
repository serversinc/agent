import { createContainerHandlers } from "./controllers/containers";
import { createImageHandlers } from "./controllers/images";
import { createNetworkHandlers } from "./controllers/networks";
import { createShellHandlers } from "./controllers/shell";

import { startServer } from "./services/Server";
import { DockerService } from "./services/Docker";
import { ShellService } from "./services/Shell";
import { WatcherService } from "./services/Watcher";
import { heartbeatService } from "./services/HeartbeatService";
import { metricsService } from "./services/MetricsService";
import { stateCheckService } from "./services/StateCheckService";

import config from "./config";

const dockerService  = new DockerService(config.DOCKER_SOCKET);
const shellService   = new ShellService();
const watcherService = new WatcherService(dockerService);

watcherService.start();
heartbeatService.start();
metricsService.start();
stateCheckService.start();

const containerHandlers = createContainerHandlers(dockerService);
const imageHandlers     = createImageHandlers(dockerService);
const networkHandlers   = createNetworkHandlers(dockerService);
const shellHandlers     = createShellHandlers(shellService);

startServer(containerHandlers, imageHandlers, networkHandlers, shellHandlers, config.PORT);
