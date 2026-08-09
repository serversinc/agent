import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import config from "../config";
import { runSecurityChecks } from "./SecurityChecks";

export class StateCheckService {
  private readonly name = "StateCheck";
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) {
      return;
    }

    info(this.name, "Starting state checks", { intervalMs: config.STATE_CHECK_INTERVAL_MS });

    this.runAndSend();

    this.intervalId = setInterval(() => {
      this.runAndSend();
    }, config.STATE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      info(this.name, "State checks stopped");
    }
  }

  private runAndSend(): void {
    try {
      const checks = runSecurityChecks();
      httpService.postSafe({ type: "state_check", checks }).then(success => {
        if (!success) {
          warn(this.name, "Failed to send state checks");
        }
      });
    } catch (err) {
      warn(this.name, "Failed to run state checks", { error: (err as Error).message });
    }
  }
}

export const stateCheckService = new StateCheckService();
