import { exec as execCallback } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execCallback);

interface ExecResult {
  output: string;
  error: string;
  exitCode: number;
}

interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

export class ShellService {
  public readonly name = "Shell";

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    try {
      const result = await execAsync(command, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { output: result.stdout ?? "", error: result.stderr ?? "", exitCode: 0 };
    } catch (err: any) {
      return {
        output: err.stdout ?? "",
        error: err.stderr ?? err.message ?? String(err),
        exitCode: err.code ?? 1,
      };
    }
  }
}
