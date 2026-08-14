import { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { demultiplexDockerStream, stripAnsiCodes, DockerLogFrameParser, DockerLogFrame, LogFrame } from "../utils/transformers";
import { DockerService } from "../services/Docker";
import { info, error as logError } from "../utils/console";
import { handleError } from "../utils/error";

interface CreateContainerOptions {
  name: string;
  image: string;
  environment?: string[];
  labels?: Record<string, string>;
  exposedPorts?: Record<string, object>;
  hostConfig?: any;
  command?: string[];
  networks?: string[];
  entrypoint?: string[];
  workingdir?: string;
  start?: boolean;
  pullImage?: boolean;
  auth?: {
    username?: string;
    password?: string;
    registry?: string;
  };
}

interface CommandRequest {
  command: string | string[];
}

export function createContainerHandlers(dockerService: DockerService) {
  if (!dockerService) throw new Error("Docker service is required");

  async function list(ctx: Context) {
    try {
      const containers = await dockerService.listContainers();
      return ctx.json(containers);
    } catch (err) {
      return handleError(ctx, err, "Container", "list containers");
    }
  }

  async function get(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      const container = await dockerService.getContainer(id);
      info("Container", "Fetched container", { id });
      return ctx.json(container);
    } catch (err) {
      return handleError(ctx, err, "Container", "get container", { id: ctx.req.param("id") });
    }
  }

  async function create(ctx: Context) {
    try {
      const options = await ctx.req.json<CreateContainerOptions>();

      const imageExists = await dockerService.checkImageExists(options.image);

      if (!imageExists || options.pullImage) {
        info("Container", "Pulling image", { image: options.image });
        await dockerService.pullImage(options.image, {
          username: options.auth?.username,
          password: options.auth?.password,
          registry: options.auth?.registry,
        });
      }

      const networks = options.networks || [];
      const EndpointsConfig = networks.reduce((acc: Record<string, { Aliases: string[] }>, net: string) => {
        if (!["host", "bridge", "none"].includes(net)) {
          acc[net] = { Aliases: [options.name] };
        }
        return acc;
      }, {});

      const container = await dockerService.createContainer({
        name: options.name,
        Image: options.image,
        Env: options.environment,
        Labels: options.labels,
        ExposedPorts: options.exposedPorts,
        HostConfig: options.hostConfig,
        Cmd: options.command,
        NetworkingConfig: {
          EndpointsConfig,
        },
        Entrypoint: options.entrypoint,
        WorkingDir: options.workingdir,
      });

      if (options.start) {
        await dockerService.startContainer(container.id);
        info("Container", "Created and started container", { id: container.id, name: options.name });
      } else {
        info("Container", "Created container", { id: container.id, name: options.name });
      }

      const containerInfo = await dockerService.getContainer(container.id);

      return ctx.json({
        success: true,
        message: "container created",
        container: containerInfo,
        containerName: containerInfo.Name,
      });
    } catch (err) {
      return handleError(ctx, err, "Container", "create container");
    }
  }

  async function remove(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      await dockerService.removeContainer(id);
      info("Container", "Removed container", { id });
      return ctx.json({ success: true, message: "container removed", id });
    } catch (err) {
      return handleError(ctx, err, "Container", "remove container", { id: ctx.req.param("id") });
    }
  }

  async function restart(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      await dockerService.restartContainer(id);
      info("Container", "Restarted container", { id });
      return ctx.json({ success: true, message: "container restarted", id });
    } catch (err) {
      return handleError(ctx, err, "Container", "restart container", { id: ctx.req.param("id") });
    }
  }

  async function start(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      await dockerService.startContainer(id);
      info("Container", "Started container", { id });
      return ctx.json({ success: true, message: "container started", id });
    } catch (err) {
      return handleError(ctx, err, "Container", "start container", { id: ctx.req.param("id") });
    }
  }

  async function stop(ctx: Context) {
    try {
      const id = ctx.req.param("id");

      // Optional grace period (seconds) before Docker SIGKILLs the
      // container, e.g. for a queue worker that needs time to finish an
      // in-flight job. Falls back to dockerService's own default when
      // omitted or when the body isn't valid JSON.
      let timeout: number | undefined;
      try {
        const body = await ctx.req.json<{ timeout?: number }>();
        if (typeof body?.timeout === "number") {
          timeout = body.timeout;
        }
      } catch {
        // no body sent — use the default
      }

      if (timeout !== undefined) {
        await dockerService.stopContainer(id, timeout);
      } else {
        await dockerService.stopContainer(id);
      }
      info("Container", "Stopped container", { id, timeout });
      return ctx.json({ success: true, message: "container stopped", id });
    } catch (err) {
      return handleError(ctx, err, "Container", "stop container", { id: ctx.req.param("id") });
    }
  }

  async function logs(ctx: Context) {
    const id = ctx.req.param("id");
    // zValidator("query", containerLogsQuerySchema) has already rejected malformed input
    // (non-numeric tail/since, anything but "true"/"false") with a 400 before this runs.
    const follow = ctx.req.query("follow") === "true";
    const tail = ctx.req.query("tail") ? Number(ctx.req.query("tail")) : undefined;
    const since = ctx.req.query("since") ? Number(ctx.req.query("since")) : undefined;
    const timestamps = ctx.req.query("timestamps") === "true";
    const stdout = ctx.req.query("stdout") !== "false";
    const stderr = ctx.req.query("stderr") !== "false";

    try {
      const inspectInfo = await dockerService.getContainer(id);
      const tty = inspectInfo.Config?.Tty ?? false;

      if (!follow) {
        const buffer = await dockerService.getContainerLogs(id, { tail, since, timestamps, stdout, stderr });
        const rawFrames: DockerLogFrame[] = tty
          ? [{ stream: "stdout", message: stripAnsiCodes(buffer.toString("utf8")) }]
          : new DockerLogFrameParser().push(buffer);

        // One response, one timestamp — these lines don't each have a known individual
        // creation time yet (see LogFrame's docs), so stamping them all "as of now" is more
        // honest than implying per-line precision we don't have.
        const now = Date.now();
        const logLines: LogFrame[] = rawFrames.map((frame, index) => ({ container_id: id, ts: now, seq: index, ...frame }));

        info("Container", "Fetched container logs", { id, tail, lines: logLines.length });
        return ctx.json({ success: true, id, logs: logLines });
      }

      return streamSSE(ctx, async sseStream => {
        // Passing the request's own AbortSignal lets dockerode cancel the underlying HTTP
        // request to the Docker daemon directly when the client disconnects — no manual
        // stream.destroy() plumbing needed.
        const dockerStream = await dockerService.streamContainerLogs(id, { tail, since, timestamps, stdout, stderr, abortSignal: ctx.req.raw.signal });
        const parser = new DockerLogFrameParser();
        let seq = 0;

        for await (const chunk of dockerStream) {
          const buffer = Buffer.from(chunk);
          const rawFrames = tty ? [{ stream: "stdout" as const, message: stripAnsiCodes(buffer.toString("utf8")) }] : parser.push(buffer);

          for (const frame of rawFrames) {
            const stamped: LogFrame = { container_id: id, ts: Date.now(), seq: seq++, ...frame };
            // `id` on the SSE event (not the frame's own container_id) is what lets a
            // browser's EventSource resume via Last-Event-ID after a reconnect.
            await sseStream.writeSSE({ event: "log", data: JSON.stringify(stamped), id: String(stamped.seq) });
          }
        }
      }, async streamErr => {
        logError("Container", "Container log stream failed", { id, error: streamErr.message });
      });
    } catch (err) {
      return handleError(ctx, err, "Container", "get container logs", { id });
    }
  }

  async function runCommand(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      const { command } = await ctx.req.json<CommandRequest>();

      const container = dockerService.docker.getContainer(id);

      // Better command parsing - handle both string and array
      const cmdArray = Array.isArray(command) ? command : ["/bin/sh", "-c", command];

      const exec = await container.exec({
        Cmd: cmdArray,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      const buffer = Buffer.concat(chunks);
      const { stdout, stderr } = demultiplexDockerStream(buffer);

      const cleanStdout = stripAnsiCodes(stdout).trim();
      const cleanStderr = stripAnsiCodes(stderr).trim();

      info("Container", "Executed command", { id, command });

      return ctx.json({
        success: true,
        message: "command executed",
        command: Array.isArray(command) ? command.join(" ") : command,
        output: { stdout: cleanStdout, stderr: cleanStderr },
      });
    } catch (err) {
      return handleError(ctx, err, "Container", "run command", { id: ctx.req.param("id") });
    }
  }

  return {
    list,
    get,
    create,
    remove,
    restart,
    start,
    logs,
    stop,
    runCommand,
  };
}