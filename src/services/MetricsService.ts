import { HostTelemetry } from "./HostTelemetry.js";
import type { ServerObservation } from "../types/ServerObservation.js";
import config from "../config.js";

/** Stable public service name for producing canonical host observations. */
export class MetricsService {
  constructor(private readonly telemetry = new HostTelemetry()) {}

  collect(): Promise<ServerObservation | null> {
    return this.telemetry.collect();
  }
}

export const metricsService = new MetricsService(new HostTelemetry({
  networkInterfaces: config.METRICS_NETWORK_INTERFACES.length ? config.METRICS_NETWORK_INTERFACES : undefined,
}));
