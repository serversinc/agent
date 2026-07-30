import { cpus, totalmem, freemem, uptime } from "os";
import { execSync } from "child_process";
import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import config from "../config";

interface DiskInfo {
  Filesystem: string;
  Type: string;
  Size: string;
  Used: string;
  Avail: string;
  "Use%": string;
  Mounted: string;
}

interface NetworkDeltas {
  rxDelta: number;
  txDelta: number;
}

export class MetricsService {
  private readonly name = "Metrics";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private prevRx = 0;
  private prevTx = 0;
  private prevRxTime = 0;

  start(): void {
    if (this.intervalId) {
      return;
    }

    info(this.name, "Starting metrics collector", {
      intervalMs: config.METRICS_INTERVAL_MS,
    });

    this.collectAndSend();

    this.intervalId = setInterval(() => {
      this.collectAndSend();
    }, config.METRICS_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      info(this.name, "Metrics collector stopped");
    }
  }

  private collectAndSend(): void {
    try {
      const payload = this.collect();
      httpService.postSafe({ type: "metrics", ...payload }).then(success => {
        if (!success) {
          warn(this.name, "Failed to send metrics");
        }
      });
    } catch (err) {
      warn(this.name, "Failed to collect metrics", {
        error: (err as Error).message,
      });
    }
  }

  private collect(): Record<string, unknown> {
    const cpuInfo = cpus();
    const loadAvg = require("os").loadavg();

    const disk = this.getDiskInfo();
    const network = this.getNetworkInfo();

    return {
      usage: {
        cpu: {
          cores: cpuInfo.length,
          load: loadAvg[0],
        },
        memory: {
          total: Math.round(totalmem() / (1024 * 1024 * 1024)),
          free: Math.round(freemem() / (1024 * 1024 * 1024)),
        },
        uptimeMinutes: Math.round(uptime() / 60),
      },
      disk,
      network,
    };
  }

  private getDiskInfo(): DiskInfo[] {
    try {
      const output = execSync("df -h --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x overlay 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      });

      const lines = output.trim().split("\n");
      const disks: DiskInfo[] = [];

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s+/);
        if (parts.length >= 7) {
          disks.push({
            Filesystem: parts[0],
            Type: parts[1],
            Size: parts[2],
            Used: parts[3],
            Avail: parts[4],
            "Use%": parts[5],
            Mounted: parts[6],
          });
        }
      }

      return disks;
    } catch {
      return [];
    }
  }

  private getNetworkInfo(): Record<string, unknown> {
    try {
      const output = execSync("cat /proc/net/dev 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      });

      let totalRx = 0;
      let totalTx = 0;

      const lines = output.trim().split("\n");
      for (let i = 2; i < lines.length; i++) {
        const parts = lines[i].trim().split(/[\s:]+/);
        if (parts.length >= 10) {
          const iface = parts[0];
          if (iface === "lo") continue;
          totalRx += parseInt(parts[1], 10) || 0;
          totalTx += parseInt(parts[9], 10) || 0;
        }
      }

      const now = Date.now();
      const rxDelta = this.prevRxTime > 0 ? totalRx - this.prevRx : 0;
      const txDelta = this.prevRxTime > 0 ? totalTx - this.prevTx : 0;

      this.prevRx = totalRx;
      this.prevTx = totalTx;
      this.prevRxTime = now;

      return {
        deltas: {
          rxDelta: Math.max(0, rxDelta),
          txDelta: Math.max(0, txDelta),
        },
      };
    } catch {
      return { deltas: { rxDelta: 0, txDelta: 0 } };
    }
  }
}

export const metricsService = new MetricsService();
