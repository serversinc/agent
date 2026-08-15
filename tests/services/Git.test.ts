import { describe, it, expect, vi, afterEach } from "vitest";

const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: errorMock, warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("child_process", () => ({ execFile: execFileMock }));

import { GitService, GitCloneError } from "../../src/services/Git";

// execFile is invoked in promisified (util.promisify) form; the mock must support the
// `(...args, callback)` shape that promisify wraps.
function mockExecFileOnce(impl: (args: string[]) => { error?: Error; stdout?: string; stderr?: string }) {
  execFileMock.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, callback: any) => {
    const cb = typeof _opts === "function" ? _opts : callback;
    const result = impl(args);
    if (result.error) {
      Object.assign(result.error, { stdout: result.stdout, stderr: result.stderr });
      cb(result.error);
    } else {
      cb(null, result.stdout ?? "", result.stderr ?? "");
    }
  });
}

describe("GitService", () => {
  afterEach(() => {
    execFileMock.mockReset();
    errorMock.mockReset();
  });

  it("clones via execFile with argv args, never interpolating the repo/token into a shell string", async () => {
    mockExecFileOnce(() => ({ stdout: "" })); // clone
    mockExecFileOnce(() => ({ stdout: "" })); // checkout

    const service = new GitService();
    await service.cloneAndCheckout("owner/repo", "abc123", "sekret", "/tmp/dest");

    const [cloneCmd, cloneArgs] = execFileMock.mock.calls[0];
    expect(cloneCmd).toBe("git");
    expect(cloneArgs).toEqual(["clone", "--quiet", "--no-checkout", "https://x-access-token:sekret@github.com/owner/repo.git", "/tmp/dest"]);

    const [checkoutCmd, checkoutArgs] = execFileMock.mock.calls[1];
    expect(checkoutCmd).toBe("git");
    expect(checkoutArgs).toEqual(["-C", "/tmp/dest", "checkout", "--quiet", "abc123"]);
  });

  it("raises a clone_failed GitCloneError with the token redacted when clone fails", async () => {
    mockExecFileOnce(() => ({ error: new Error("clone failed"), stderr: "fatal: could not read Username for 'https://x-access-token:sekret@github.com'" }));

    const service = new GitService();
    const err = await service.cloneAndCheckout("owner/repo", "abc123", "sekret", "/tmp/dest").catch(e => e);

    expect(err).toBeInstanceOf(GitCloneError);
    expect((err as GitCloneError).reason).toBe("clone_failed");
    expect((err as Error).message).not.toContain("sekret");
    expect((err as Error).message).toContain("***");

    // the failed step's argv (which embeds the token in the clone URL) must never reach the logger raw
    const loggedMeta = errorMock.mock.calls[0][2];
    expect(JSON.stringify(loggedMeta)).not.toContain("sekret");
  });

  it("raises a checkout_failed GitCloneError when the commit/branch doesn't exist", async () => {
    mockExecFileOnce(() => ({ stdout: "" })); // clone succeeds
    mockExecFileOnce(() => ({ error: new Error("checkout failed"), stderr: "error: pathspec 'deadbeef' did not match any file(s) known to git" }));

    const service = new GitService();
    const err = await service.cloneAndCheckout("owner/repo", "deadbeef", "sekret", "/tmp/dest").catch(e => e);

    expect(err).toBeInstanceOf(GitCloneError);
    expect((err as GitCloneError).reason).toBe("checkout_failed");
  });
});
