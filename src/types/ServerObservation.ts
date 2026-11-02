/** Canonical v1 host telemetry payload accepted by the heartbeat API. */
export interface ServerObservation {
  schema_version: 1;
  sample_id: string;
  boot_id: string;
  observed_at: string;
  collectors: {
    cpu: CpuObservation;
    memory: MemoryObservation;
    network: NetworkObservation;
    disk: DiskObservation;
  };
}

export type CollectorFailure = { status: "failed" | "unsupported"; observed_at: string };

export type CpuObservation =
  | CollectorFailure
  | {
      status: "success";
      observed_at: string;
      utilisation_pct: number;
      measured_duration_seconds: number;
      cores?: number;
    }
  | {
      status: "first_sample" | "reset";
      observed_at: string;
    };

export type MemoryObservation =
  | CollectorFailure
  | {
      status: "success";
      observed_at: string;
      used_bytes: number;
      total_bytes: number;
    };

export type NetworkObservation =
  | CollectorFailure
  | {
      status: "success";
      observed_at: string;
      rx_bytes_delta: number;
      tx_bytes_delta: number;
      measured_duration_seconds: number;
    }
  | {
      status: "first_sample" | "reset";
      observed_at: string;
    };

export interface DiskMountObservation {
  mount: string;
  size_bytes: number;
  used_bytes: number;
  available_bytes: number;
  filesystem?: string;
  fs_type?: string;
}

export type DiskObservation =
  | CollectorFailure
  | {
      status: "success";
      observed_at: string;
      mounts: DiskMountObservation[];
    };
