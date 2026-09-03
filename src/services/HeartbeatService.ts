import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import config from "../config";

export interface HeartbeatAgentUpdate {
  target_version?: string;
  target_image?: string;
  min_version?: string;
}

interface HeartbeatResponse {
  agent?: HeartbeatAgentUpdate;
}

export class HeartbeatService {
  private readonly name = "Heartbeat";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private targetVersionHandler: ((agent: HeartbeatAgentUpdate) => void) | null = null;

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

  setTargetVersionHandler(handler: (agent: HeartbeatAgentUpdate) => void): void {
    this.targetVersionHandler = handler;
  }

  private async send(): Promise<void> {
    try {
      const response = await httpService.post<HeartbeatResponse>({ type: "alive" });

      if (response?.agent && this.targetVersionHandler) {
        this.targetVersionHandler(response.agent);
      }
    } catch {
      warn(this.name, "Failed to send heartbeat");
    }
  }
}

export const heartbeatService = new HeartbeatService();
