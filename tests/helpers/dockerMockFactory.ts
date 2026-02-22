import { vi } from "vitest";
import type { DockerService } from "../../src/services/Docker";
import type Dockerode from "dockerode";

// Create a typed mock for the DockerService. The nested `docker` object uses dockerode types
export function createDockerMock(overrides: Partial<DockerService & { docker?: Partial<Dockerode> }> = {}): Partial<DockerService> {
  const base: any = {
    // container-related
    listContainers: vi.fn() as any,
    getContainer: vi.fn() as any,
    createContainer: vi.fn() as any,
    removeContainer: vi.fn() as any,
    restartContainer: vi.fn() as any,
    startContainer: vi.fn() as any,
    stopContainer: vi.fn() as any,
    checkImageExists: vi.fn() as any,

    // image-related
    listImages: vi.fn() as any,
    getImage: vi.fn() as any,
    pullImage: vi.fn() as any,
    removeImage: vi.fn() as any,
    pruneImages: vi.fn() as any,

    docker: {
      getContainer: vi.fn() as unknown as (id: string) => Dockerode.Container,
      listNetworks: vi.fn() as unknown as () => Promise<Dockerode.NetworkInspectInfo[]>,
      getNetwork: vi.fn() as unknown as (id: string) => Dockerode.Network,
      createNetwork: vi.fn() as unknown as (opts: any) => Promise<Dockerode.Network>,
    } as Partial<Dockerode>,
  };

  // shallow merge, with special handling for nested `docker` object
  const result: any = { ...(base as any), ...(overrides as any) };
  if (overrides && (overrides as any).docker) {
    result.docker = { ...(base as any).docker, ...(overrides as any).docker };
  }

  return result as Partial<DockerService>;
}
