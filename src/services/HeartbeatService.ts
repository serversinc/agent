import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import config from "../config";

export class HeartbeatService {
  private readonly name = "Heartbeat";
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) {
      return;
    }

    info(this.name, "Starting heartbeat", {
      intervalMs: config.HEARTBEAT_INTERVAL_MS,
    });

    this.send();

    this.intervalId = setInterval(() => {
      this.send();
    }, config.HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      info(this.name, "Heartbeat stopped");
    }
  }

  private send(): void {
    httpService.postSafe({ type: "alive" }).then(success => {
      if (!success) {
        warn(this.name, "Failed to send heartbeat");
      }
    });
  }
}

export const heartbeatService = new HeartbeatService();
