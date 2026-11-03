import { cpus, freemem, loadavg, totalmem, uptime } from "os";
import { execSync } from "child_process";
import { readFileSync } from "fs";

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

interface CpuUsage {
  cores: number;
  utilisation: number;
  load: number;
}

interface MemoryUsage {
  total: number;
  free: number;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
}

const CPU_SAMPLE_MS = 1000;

export class MetricsService {
  private prevRx = 0;
  private prevTx = 0;
  private prevRxTime = 0;

  async collect(): Promise<Record<string, unknown>> {
    const cpu = await this.getCpuUsage();
    const memory = this.getMemoryUsage();

    const disk = this.getDiskInfo();
    const network = this.getNetworkInfo();

    return {
      usage: {
        cpu,
        memory,
        uptimeMinutes: Math.round(uptime() / 60),
      },
      disk,
      network,
    };
  }

  private async getCpuUsage(sampleMs: number = CPU_SAMPLE_MS): Promise<CpuUsage> {
    const start = this.readCpuTimes();
    await new Promise(resolve => setTimeout(resolve, sampleMs));
    const end = this.readCpuTimes();

    const idleDelta = end.idle - start.idle;
    const totalDelta = end.total - start.total;

    const utilisation = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

    return {
      cores: cpus().length,
      utilisation: Math.min(100, Math.max(0, Math.round(utilisation * 100) / 100)),
      load: loadavg()[0],
    };
  }

  private readCpuTimes(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;

    for (const cpu of cpus()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }

    return { idle, total };
  }

  private getMemoryUsage(): MemoryUsage {
    const totalBytes = totalmem();
    const freeBytes = freemem();

    const availableBytes = this.readMemAvailable() ?? freeBytes;

    return {
      total: Math.round(totalBytes / (1024 * 1024 * 1024)),
      free: Math.round(freeBytes / (1024 * 1024 * 1024)),
      total_bytes: totalBytes,
      used_bytes: Math.max(0, totalBytes - availableBytes),
      available_bytes: availableBytes,
    };
  }

  private readMemAvailable(): number | null {
    try {
      const output = readFileSync("/proc/meminfo", "utf8");
      const match = output.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (!match) {
        return null;
      }
      return parseInt(match[1], 10) * 1024;
    } catch {
      return null;
    }
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
