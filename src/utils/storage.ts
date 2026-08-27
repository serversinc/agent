import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { stat, statfs, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// If the agent has less than this free we refuse to stage an archive rather than
// risk filling the disk and taking the server down with it.
const MIN_FREE_BYTES = 512 * 1024 * 1024;

// Wall-clock ceiling on a single pre-signed transfer. Large archives can be slow,
// but a transfer must never hang the agent forever when storage stalls or returns
// an early error response — a streamed half-duplex PUT will otherwise deadlock in
// undici instead of surfacing the error. A hit surfaces as a *_failed event.
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

async function readBodySafe(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return "";
  }
}

export async function assertDiskSpace(): Promise<void> {
  const { bsize, bavail } = await statfs(tmpdir());
  const freeBytes = bsize * bavail;

  if (freeBytes < MIN_FREE_BYTES) {
    throw new Error(`Insufficient disk space for backup staging: ${freeBytes} bytes free`);
  }
}

export function tempPath(name: string): string {
  return join(tmpdir(), name);
}

// Runs `fn` with a temp file path, then deletes the file no matter what.
export async function withTempFile<T>(name: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = tempPath(name);

  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => {});
  }
}

export async function stageToFile(source: Readable, path: string): Promise<void> {
  await pipeline(source, createWriteStream(path));
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

export async function fileSize(path: string): Promise<number> {
  const { size } = await stat(path);
  return size;
}

// Uploads a local file to a pre-signed PUT URL, streamed from disk with an
// explicit Content-Length so undici does not fall back to chunked
// transfer-encoding (which AWS S3 rejects on a pre-signed PUT). The abort signal
// bounds the transfer and, as a side effect, lets undici surface an early error
// response instead of deadlocking on the half-duplex body.
export async function uploadFile(presignedUrl: string, path: string): Promise<void> {
  const size = await fileSize(path);

  const response = await fetch(presignedUrl, {
    method: "PUT",
    body: createReadStream(path),
    duplex: "half",
    headers: { "Content-Length": String(size) },
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  } as unknown as RequestInit);

  if (!response.ok) {
    const detail = await readBodySafe(response);
    throw new Error(`Storage upload failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
}

// Downloads a pre-signed GET URL to a local file without buffering it in memory.
export async function downloadFile(presignedUrl: string, path: string): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "GET",
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    const detail = await readBodySafe(response);
    throw new Error(`Storage download failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
}
