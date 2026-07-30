import { Context } from "hono";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ShellService } from "../services/Shell";

const COMPOSE_BASE = "/srv/compose";

export function createShellHandlers(shellService: ShellService) {
  if (!shellService) throw new Error("Shell service is required");

  async function runShell(ctx: Context) {
    const { command } = await ctx.req.json<{ command: string }>();
    const result = await shellService.exec(command, { timeout: 120_000 });
    return ctx.json({
      output: result.output,
      error: result.error,
      exit_code: result.exitCode,
    });
  }

  async function runCompose(ctx: Context) {
    const { project, compose, env } = await ctx.req.json<{
      project: string;
      compose: string;
      env?: Record<string, string>;
    }>();

    const dir = join(COMPOSE_BASE, project);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "docker-compose.yml"), compose, "utf-8");

    if (env && Object.keys(env).length > 0) {
      const envContent = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      writeFileSync(join(dir, ".env"), envContent, "utf-8");
    }

    const result = await shellService.exec(`docker compose -p ${project} up -d`, {
      cwd: dir,
      timeout: 300_000,
    });

    return ctx.json({
      output: result.output,
      error: result.error,
      exit_code: result.exitCode,
    });
  }

  async function execContainer(ctx: Context) {
    const { container, command } = await ctx.req.json<{
      container: string;
      command: string;
    }>();

    const escaped = command.replace(/'/g, "'\\''");
    const result = await shellService.exec(
      `docker exec ${container} sh -c '${escaped}'`,
      { timeout: 120_000 },
    );

    return ctx.json({
      output: result.output,
      error: result.error,
      exit_code: result.exitCode,
    });
  }

  return { runShell, runCompose, execContainer };
}
