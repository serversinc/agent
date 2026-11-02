import { info, warn } from "../utils/console";
import { httpService } from "./Http";
import { metricsService } from "./MetricsService";
import config from "../config";
import type { ServerObservation } from "../types/ServerObservation";

export interface HeartbeatAgentUpdate {
  target_version?: string;
  target_image?: string;
  min_version?: string;
}

interface HeartbeatResponse {
  agent?: HeartbeatAgentUpdate;
  metrics?: {
    status?: unknown;
    retryable?: unknown;
  };
}

const METRIC_STATUSES = new Set(["persisted", "duplicate", "conflict", "invalid", "failed", "skipped"]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

export class HeartbeatService {
  private readonly name = "Heartbeat";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private targetVersionHandler: ((agent: HeartbeatAgentUpdate) => void) | null = null;
  private generation = 0;
  private inFlight = false;

  start(): void {
    if (this.intervalId) {
      return;
    }

    info(this.name, "Starting heartbeat", {
      intervalMs: config.HEARTBEAT_INTERVAL_MS,
    });

    const generation = ++this.generation;
    void this.send(generation);

    this.intervalId = setInterval(() => {
      void this.send(generation);
    }, config.HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    this.generation++;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      info(this.name, "Heartbeat stopped");
    }
  }

  setTargetVersionHandler(handler: (agent: HeartbeatAgentUpdate) => void): void {
    this.targetVersionHandler = handler;
  }

  /**
   * Lightweight liveness round-trip with no usage payload and no update handling.
   * Used as a readiness probe.
   */
  async ping(): Promise<boolean> {
    return httpService.postSafe({ type: "alive" });
  }

  private async send(generation: number): Promise<void> {
    if (generation !== this.generation || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      let observation: ServerObservation | null = null;
      try {
        observation = await metricsService.collect();
      } catch (err) {
        warn(this.name, "Failed to collect observation for heartbeat", {
          error: err instanceof Error ? err.name : "unknown",
        });
      }

      if (generation !== this.generation) return;
      const body: { type: "alive"; observation?: ServerObservation } = observation
        ? { type: "alive", observation }
        : { type: "alive" };
      if (!observation) {
        warn(this.name, "Host telemetry unavailable; sending liveness only");
      }

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (generation !== this.generation) return;
        let response: HeartbeatResponse | void;
        try {
          response = await httpService.post<HeartbeatResponse>(body);
        } catch (err) {
          if (generation !== this.generation) return;
          if (observation && attempt === 1 && this.isTransientPostError(err)) continue;
          warn(this.name, "Failed to send heartbeat");
          return;
        }

        if (generation !== this.generation) return;
        this.processAgentTarget(response, generation);
        if (!observation) return;
        if (!response || !this.isKnownMetricsAck(response)) {
          warn(this.name, "Heartbeat returned an unrecognized metrics acknowledgement");
          return;
        }
        const status = response.metrics!.status as string;
        if (status === "conflict" || status === "invalid") {
          warn(this.name, `Heartbeat metrics rejected (${status})`);
          return;
        }
        if (status === "failed" && response.metrics!.retryable === true && attempt === 1) continue;
        if (status === "failed" && response.metrics!.retryable === true) {
          warn(this.name, "Heartbeat metrics ingestion remains retryable after retry");
        } else if (status === "failed") {
          warn(this.name, "Heartbeat metrics ingestion failed without retry");
        } else if (status === "skipped") {
          warn(this.name, "Heartbeat metrics ingestion skipped for sent observation");
        }
        return;
      }
    } finally {
      this.inFlight = false;
      if (generation !== this.generation && this.intervalId !== null) {
        void this.send(this.generation);
      }
    }
  }

  private isKnownMetricsAck(response: HeartbeatResponse): boolean {
    const metrics = response.metrics;
    if (!metrics || typeof metrics !== "object") return false;
    return typeof metrics.status === "string" && METRIC_STATUSES.has(metrics.status) && typeof metrics.retryable === "boolean";
  }

  private processAgentTarget(response: HeartbeatResponse | void, generation: number): void {
    if (generation !== this.generation || !response?.agent || !this.targetVersionHandler) return;
    try {
      this.targetVersionHandler(response.agent);
    } catch {
      warn(this.name, "Failed to process agent update target");
    }
  }

  private isTransientPostError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === "AbortError") return true;
    const httpStatus = /^HTTP (\d{3}):/.exec(error.message)?.[1];
    if (httpStatus) {
      const status = Number(httpStatus);
      return status === 429 || (status >= 500 && status <= 599);
    }
    if (error instanceof SyntaxError) return false;
    if (error instanceof TypeError && error.message === "fetch failed") return true;
    const cause = (error as Error & { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === "string" && TRANSIENT_NETWORK_CODES.has(cause.code);
  }
}

export const heartbeatService = new HeartbeatService();
