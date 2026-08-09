import { Context } from "hono";
import { DockerService } from "../services/Docker";
import { info } from "../utils/console";
import { handleError } from "../utils/error";

export function createVolumeHandlers(dockerService: DockerService) {
  if (!dockerService) throw new Error("Docker service is required");

  async function list(ctx: Context) {
    try {
      const volumes = await dockerService.docker.listVolumes();
      info("Volume", "Listed volumes");
      return ctx.json(volumes);
    } catch (err) {
      return handleError(ctx, err, "Volume", "list volumes");
    }
  }

  async function get(ctx: Context) {
    try {
      const name = ctx.req.param("name");
      const volume = dockerService.docker.getVolume(name);
      const data = await volume.inspect();
      return ctx.json(data);
    } catch (err) {
      return handleError(ctx, err, "Volume", "get volume", { name: ctx.req.param("name") });
    }
  }

  async function create(ctx: Context) {
    try {
      const options = await ctx.req.json();

      const volume = await dockerService.docker.createVolume({
        Name: options.name,
        Driver: options.driver || "local",
        Labels: options.labels || {},
      });

      info("Volume", "Created volume", { name: options.name });
      return ctx.json(volume, 201);
    } catch (err) {
      return handleError(ctx, err, "Volume", "create volume");
    }
  }

  async function remove(ctx: Context) {
    try {
      const name = ctx.req.param("name");
      const volume = dockerService.docker.getVolume(name);
      await volume.remove();
      info("Volume", "Removed volume", { name });
      return ctx.json({ success: true, message: "volume removed", name });
    } catch (err) {
      return handleError(ctx, err, "Volume", "remove volume", { name: ctx.req.param("name") });
    }
  }

  return { list, get, create, remove };
}
