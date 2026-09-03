import { DockerService } from "./Docker";
import { httpService } from "./Http";
import { info, warn, error as logError } from "../utils/console";
import config from "../config";
import type { HeartbeatAgentUpdate } from "./HeartbeatService";

interface UpdateTarget {
  version: string;
  image: string;
}

export class SelfUpdateService {
  public readonly name = "SelfUpdate";

  static readonly ROLE_LABEL = "com.serversinc.role";
  static readonly ROLE_VALUE = "agent";
  static readonly CANONICAL_NAME = "agent";
  static readonly DEBOUNCE_THRESHOLD = 3;
  static readonly MAX_JITTER_MS = 15 * 60 * 1000;
  static readonly HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;
  static readonly STOP_GRACE_SECONDS = 140;

  private pendingTarget: UpdateTarget | null = null;
  private consecutiveMatches = 0;
  private updateTriggered = false;

  constructor(
    private readonly docker: DockerService,
    private readonly containerId: string,
    private readonly currentVersion: string,
    private readonly jitterMs: () => number = () => Math.floor(Math.random() * SelfUpdateService.MAX_JITTER_MS),
    private readonly scheduleFn: (fn: () => void, ms: number) => void = (fn, ms) => {
      setTimeout(fn, ms);
    },
  ) { }

  onHeartbeatTarget(agent: HeartbeatAgentUpdate): void {
    if (this.updateTriggered) {
      return;
    }

    if (!agent.target_version || !agent.target_image || agent.target_version === this.currentVersion) {
      this.pendingTarget = null;
      this.consecutiveMatches = 0;

      return;
    }

    if (this.pendingTarget?.version === agent.target_version) {
      this.consecutiveMatches += 1;
    } else {
      this.pendingTarget = { version: agent.target_version, image: agent.target_image };
      this.consecutiveMatches = 1;
    }

    if (this.consecutiveMatches >= SelfUpdateService.DEBOUNCE_THRESHOLD) {
      const target = this.pendingTarget;
      this.updateTriggered = true;
      const jitter = this.jitterMs();

      info(this.name, "Target version confirmed, scheduling update", { target, jitterMs: jitter });

      this.scheduleFn(() => {
        this.beginUpdate(target).catch(err => {
          logError(this.name, "Self-update failed to start", { error: (err as Error).message });
          this.resetDebounce();
        });
      }, jitter);
    }
  }

  async beginUpdate(target: UpdateTarget): Promise<void> {
    info(this.name, "Beginning self-update", { target });
    await this.reportUpdate("agent_update_started", { target_version: target.version });

    const inspect = await this.docker.getContainer(this.containerId);
    const tempName = `agent-update-${Date.now().toString(36)}`;

    if (!(await this.docker.checkImageExists(target.image))) {
      await this.docker.pullImage(target.image);
    }

    const labels = {
      ...(inspect.Config?.Labels ?? {}),
      [SelfUpdateService.ROLE_LABEL]: SelfUpdateService.ROLE_VALUE,
    };

    const created = await this.docker.createContainer({
      name: tempName,
      Image: target.image,
      Env: inspect.Config?.Env,
      Labels: labels,
      ExposedPorts: inspect.Config?.ExposedPorts,
      HostConfig: inspect.HostConfig,
    });

    await this.docker.startContainer(created.id);

    info(this.name, "Sibling container started, handoff pending", { id: created.id.slice(0, 12), tempName, target });

    this.scheduleFn(() => {
      this.checkHandoff(created.id).catch(err => {
        logError(this.name, "Failed to check self-update handoff", { error: (err as Error).message });
      });
    }, SelfUpdateService.HANDOFF_TIMEOUT_MS);
  }

  private async checkHandoff(siblingId: string): Promise<void> {
    let inspect;

    try {
      inspect = await this.docker.getContainer(siblingId);
    } catch {
      this.resetDebounce();

      return;
    }

    const name = inspect.Name?.replace(/^\//, "");
    if (name === SelfUpdateService.CANONICAL_NAME) {
      return;
    }

    warn(this.name, "Self-update handoff did not complete in time, cleaning up stuck sibling", { id: siblingId.slice(0, 12) });

    try {
      await this.docker.removeContainer(siblingId, true);
    } catch (err) {
      logError(this.name, "Failed to clean up stuck sibling", { id: siblingId.slice(0, 12), error: (err as Error).message });
    }

    this.resetDebounce();
  }

  async checkForTakeoverOnBoot(): Promise<void> {
    const predecessor = await this.findPredecessor();

    if (!predecessor) {
      info(this.name, "No predecessor found on boot — normal startup");

      return;
    }

    info(this.name, "Predecessor agent found — verifying self before takeover", { predecessor: predecessor.Id.slice(0, 12) });

    const healthy = await this.verifySelf();

    if (!healthy) {
      warn(this.name, "Self-check failed — aborting takeover, leaving predecessor untouched");
      await this.reportUpdate("agent_update_failed", { reason: "self-check failed after startup" });
      await this.cleanupSelf();

      return;
    }

    try {
      await this.docker.stopContainer(predecessor.Id, SelfUpdateService.STOP_GRACE_SECONDS);
    } catch (err) {
      warn(this.name, "Failed to gracefully stop predecessor, forcing removal", { error: (err as Error).message });
    }

    try {
      await this.docker.removeContainer(predecessor.Id, true);
      await this.docker.renameContainer(this.containerId, SelfUpdateService.CANONICAL_NAME);
    } catch (err) {
      logError(this.name, "Passed self-check but failed while retiring the predecessor", { error: (err as Error).message });
      await this.reportUpdate("agent_update_failed", { reason: "failed to retire predecessor or rename after a successful self-check" });

      return;
    }

    info(this.name, "Self-update takeover completed", { version: this.currentVersion });
    await this.reportUpdate("agent_update_completed", { version: this.currentVersion });
  }

  private async findPredecessor(): Promise<{ Id: string } | null> {
    const siblings = await this.docker.listContainersByLabel(SelfUpdateService.ROLE_LABEL, SelfUpdateService.ROLE_VALUE);

    return siblings.find(sibling => !this.isSelf(sibling.Id)) ?? null;
  }

  private isSelf(id: string): boolean {
    return id === this.containerId || id.startsWith(this.containerId) || this.containerId.startsWith(id);
  }

  private async verifySelf(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${config.PORT}/health`);

      if (!response.ok) {
        return false;
      }
    } catch {
      return false;
    }

    return httpService.postSafe({ type: "alive" });
  }

  private async cleanupSelf(): Promise<void> {
    try {
      await this.docker.removeContainer(this.containerId, true);
    } catch (err) {
      logError(this.name, "Failed to clean up after a failed takeover", { error: (err as Error).message });
    }
  }

  private async reportUpdate(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    await httpService.postSafe({ type, ...extra });
  }

  private resetDebounce(): void {
    this.updateTriggered = false;
    this.pendingTarget = null;
    this.consecutiveMatches = 0;
  }
}
