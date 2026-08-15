import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { error, info } from "../utils/console";

const execFile = promisify(execFileCallback);

export class GitCloneError extends Error {
  constructor(
    message: string,
    public readonly reason: "clone_failed" | "checkout_failed",
  ) {
    super(message);
    this.name = "GitCloneError";
  }
}

export class GitService {
  public readonly name = "Git";

  // Clones `owner/repo` at `commit` into `destDir` using an ephemeral token embedded in the
  // remote URL. execFile (no shell) so nothing in `repo` or `token` can be interpreted as shell syntax.
  async cloneAndCheckout(repo: string, commit: string, token: string, destDir: string): Promise<void> {
    const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

    info(this.name, "Cloning repository", { repo, commit, destDir });

    await this.runGit(["clone", "--quiet", "--no-checkout", remoteUrl, destDir], 120_000, token, "clone_failed", `Failed to clone ${repo}`);
    await this.runGit(["-C", destDir, "checkout", "--quiet", commit], 60_000, token, "checkout_failed", `Failed to checkout ${commit} on ${repo}`);

    info(this.name, "Checked out repository", { repo, commit });
  }

  // Runs one `git` step and normalizes any failure into a GitCloneError with a redacted,
  // step-specific message — clone and checkout only differ in argv, timeout, and that message.
  private async runGit(args: string[], timeout: number, token: string, reason: GitCloneError["reason"], failureContext: string): Promise<void> {
    try {
      await execFile("git", args, { timeout });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const redact = (s: string) => (token ? s.split(token).join("***") : s);
      const message = redact((e.stderr || e.message || String(err)).trim());

      error(this.name, failureContext, { args: args.map(redact), error: message });
      throw new GitCloneError(`${failureContext}: ${message}`, reason);
    }
  }
}
